import DB from '../database';
import logger from '../logger';
import { Common } from '../api/common';
import { BlockExtended, PoolTag } from '../mempool.interfaces';
import { parseDATUMTemplateCreator, tagsPrivateTemplates } from '../utils/bitcoin-script';
import { POOLS_STATS_INTERVALS } from './PoolsRepository';

export interface MinerInfo {
  poolId: number; // mysql pools row id
  name: string;
  blockCount: number;
}

/** The longest miner tag `blocks_miners` can hold; longer tags are truncated to fit */
const MAX_MINER_NAME_LENGTH = 64;

/**
 * What the blocks of a gateway without a miner tag are ranked under. The parser strips
 * parentheses from every tag, so no coinbase can claim this name for itself.
 */
const UNTAGGED_MINER_NAME = '(untagged)';

/** How many blocks the backfill reads at a time, bounding both the query and the memory it needs */
const BACKFILL_CHUNK_SIZE = 1000;

/** Cap on one backfill run, so a pathological backlog cannot hold up the rest of the indexer */
const BACKFILL_MAX_BLOCKS = 100000;

/**
 * Miner tags carried by the coinbase of blocks built through a DATUM gateway.
 *
 * Only pools flagged `datum` are indexed: for every other pool the coinbase tag is the pool's
 * own, which `blocks.pool_id` already records. Names are interned in `miner_names` and blocks
 * reference them by id from `blocks_miners`, which holds nothing but DATUM blocks — a few
 * thousand rows that the pools ranking can aggregate without reading `blocks`.
 */
class MinerNamesRepository {
  /** name -> miner_names.id, so repeated blocks from the same miner cost no query at all */
  private nameIds: Map<string, number> = new Map();

  /**
   * The miner tag a DATUM coinbase attributes the template to, or null when the pool built it
   * itself. minerNames[0] is the pool's own tag, minerNames[1] the gateway operator's.
   *
   * A coinbase with no miner tag is usually the pool's own, but a pool that marks its own
   * templates with a private tag (see PRIVATE_TAG_POOLS) leaves no block untagged, so for such
   * a pool it is a gateway whose operator left the tag empty.
   */
  public getMinerName(coinbaseRaw: string | undefined, poolSlug: string): string | null {
    if (!coinbaseRaw) {
      return null;
    }

    const minerNames = parseDATUMTemplateCreator(coinbaseRaw, poolSlug);
    if (!minerNames) { // the pool's private tag
      return null;
    }

    const name = minerNames.length > 1 ? minerNames[1].trim() : '';
    if (name.length) {
      return name.slice(0, MAX_MINER_NAME_LENGTH);
    }

    return tagsPrivateTemplates(poolSlug) ? UNTAGGED_MINER_NAME : null;
  }

  /**
   * Record which miner built a block's template. Called for every indexed block, and a no-op
   * unless the block's pool speaks DATUM: for any other pool the coinbase tag is the pool's
   * own, so parsing it as a miner tag would only intern noise.
   *
   * @asyncSafe
   */
  public async $saveMinerName(block: BlockExtended, pool: PoolTag): Promise<void> {
    if (!pool.datum) {
      return;
    }

    try {
      const name = this.getMinerName(block.extras.coinbaseRaw, pool.slug);
      await this.$saveBlockMiner(block.id, block.height, pool.id, name === null ? null : await this.$getNameId(name), block.timestamp, block.stale === true);
    } catch (e) {
      // a missing miner tag only costs this block its band of the ranking, so it must not
      // fail the block's own indexing
      logger.err(`Cannot save miner name for block ${block.id}. Reason: ` + (e instanceof Error ? e.message : e));
    }
  }

  /**
   * A null `minerId` records a DATUM block the pool built itself: the ranking ignores the row,
   * but its presence is what keeps the backfill from reading the block again.
   *
   * @asyncUnsafe
   */
  private async $saveBlockMiner(hash: string, height: number, poolId: number, minerId: number | null, blockTimestamp: number, stale: boolean): Promise<void> {
    await DB.query(`
      INSERT INTO blocks_miners(hash, height, pool_id, miner_id, blockTimestamp, stale)
      VALUE (?, ?, ?, ?, FROM_UNIXTIME(?), ?)
      ON DUPLICATE KEY UPDATE pool_id = VALUES(pool_id), miner_id = VALUES(miner_id), stale = VALUES(stale)`,
      [hash, height, poolId, minerId, blockTimestamp, stale ? 1 : 0]
    );
  }

  /**
   * Mirror a reorg into `blocks_miners`, which carries its own copy of `blocks.stale`
   * @asyncUnsafe
   */
  public async $setCanonicalBlockAtHeight(hash: string | null, height: number): Promise<void> {
    if (hash) {
      await DB.query(`UPDATE blocks_miners SET stale = 0 WHERE hash = ?`, [hash]);
    }
    await DB.query(`UPDATE blocks_miners SET stale = 1 WHERE height = ? AND hash != ?`, [height, hash ?? '']);
  }

  /**
   * Blocks per miner over every ranking interval, in one pass over `blocks_miners`.
   *
   * Shaped like PoolsRepository.$getPoolsInfoPerInterval: one aggregate column per interval so
   * that the whole cache is built from a single query.
   *
   * @asyncUnsafe
   */
  public async $getMinersInfoPerInterval(): Promise<Record<string, MinerInfo[]>> {
    const columns = POOLS_STATS_INTERVALS.map((label) => {
      const sql = Common.getSqlInterval(label);
      const inWindow = sql ? `blocks_miners.blockTimestamp BETWEEN DATE_SUB(NOW(), INTERVAL ${sql}) AND NOW()` : '1';
      return `COUNT(CASE WHEN ${inWindow} THEN 1 END) AS \`blockCount_${label}\``;
    }).join(',');

    const query = `SELECT
        blocks_miners.pool_id AS poolId,
        miner_names.name AS name,
        ${columns}
      FROM blocks_miners
      JOIN miner_names ON miner_names.id = blocks_miners.miner_id
      WHERE blocks_miners.stale = 0
      GROUP BY blocks_miners.pool_id, blocks_miners.miner_id`; // the join drops pool-built blocks, whose miner_id is null

    const result: Record<string, MinerInfo[]> = {};
    for (const label of POOLS_STATS_INTERVALS) {
      result[label] = [];
    }

    try {
      const [rows]: any[] = await DB.query(query);

      for (const row of rows) {
        for (const label of POOLS_STATS_INTERVALS) {
          if (row[`blockCount_${label}`] > 0) {
            result[label].push({
              poolId: row.poolId,
              name: row.name,
              blockCount: row[`blockCount_${label}`],
            });
          }
        }
      }

      // biggest miner first, name breaking ties so the order is stable across rebuilds
      for (const miners of Object.values(result)) {
        miners.sort((a, b) => b.blockCount - a.blockCount || a.name.localeCompare(b.name));
      }

      return result;
    } catch (e) {
      logger.err(`Cannot generate miners stats per interval. Reason: ` + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  /**
   * Index DATUM blocks that predate this table, or that were indexed while the pool was not yet
   * flagged as DATUM.
   *
   * Finding them is covered by the `pool_id` index on `blocks` (InnoDB appends the primary key,
   * so pool_id + hash is read from the index alone), which keeps the common case — nothing to
   * do — off the blocks themselves. Only the coinbases that are actually missing are then read.
   *
   * The search is deliberately unordered: sorting it by height would let the planner walk the
   * `height` index instead and read every block in the table on a pass that has nothing to do.
   * Which blocks a chunk picks up does not matter, since the loop runs until none are left.
   *
   * @asyncSafe
   */
  public async $indexMissingMiners(): Promise<void> {
    try {
      // a pool that stopped being flagged as DATUM must not keep its miners in the ranking
      await DB.query(`
        DELETE blocks_miners FROM blocks_miners
        JOIN pools ON pools.id = blocks_miners.pool_id
        WHERE pools.datum = 0`
      );

      let indexed = 0;
      while (indexed < BACKFILL_MAX_BLOCKS) {
        const [missing]: any[] = await DB.query(`
          SELECT blocks.hash
          FROM blocks
          JOIN pools ON pools.id = blocks.pool_id AND pools.datum = 1
          LEFT JOIN blocks_miners ON blocks_miners.hash = blocks.hash
          WHERE blocks_miners.hash IS NULL
          LIMIT ${BACKFILL_CHUNK_SIZE}`
        );

        if (!missing.length) {
          break;
        }

        // only now, for blocks known to be missing, is a coinbase actually read
        const [rows]: any[] = await DB.query(`
          SELECT blocks.hash, blocks.height, blocks.pool_id AS poolId, pools.slug AS poolSlug, blocks.stale,
            UNIX_TIMESTAMP(blocks.blockTimestamp) AS blockTimestamp, blocks.coinbase_raw AS coinbaseRaw
          FROM blocks
          JOIN pools ON pools.id = blocks.pool_id
          WHERE blocks.hash IN (${missing.map(() => '?').join(',')})`,
          missing.map((row) => row.hash)
        );

        for (const row of rows) {
          const name = this.getMinerName(row.coinbaseRaw, row.poolSlug);
          await this.$saveBlockMiner(row.hash, row.height, row.poolId, name === null ? null : await this.$getNameId(name), row.blockTimestamp, row.stale);
        }
        indexed += rows.length;

        if (rows.length < missing.length) {
          // a hash vanished between the two queries, which the next pass would look for again
          break;
        }
      }

      if (indexed > 0) {
        logger.notice(`Indexed miner names for ${indexed} DATUM blocks`, logger.tags.mining);
      }
    } catch (e) {
      logger.err(`Cannot index missing miner names. Reason: ` + (e instanceof Error ? e.message : e));
    }
  }

  /**
   * Intern a miner name, from the in-memory map where possible.
   * @asyncUnsafe
   */
  private async $getNameId(name: string): Promise<number> {
    const cached = this.nameIds.get(name);
    if (cached !== undefined) {
      return cached;
    }

    // INSERT IGNORE would burn an auto-increment value on every already-known name, so the
    // read comes first and the insert only runs for names this instance has never seen
    const [rows]: any[] = await DB.query(`SELECT id FROM miner_names WHERE name = ?`, [name]);
    let id: number;
    if (rows.length) {
      id = rows[0].id;
    } else {
      const [result]: any[] = await DB.query(`INSERT IGNORE INTO miner_names(name) VALUE (?)`, [name]);
      if (result.insertId) {
        id = result.insertId;
      } else { // another writer inserted it first
        const [existing]: any[] = await DB.query(`SELECT id FROM miner_names WHERE name = ?`, [name]);
        id = existing[0].id;
      }
    }

    this.nameIds.set(name, id);
    return id;
  }
}

export default new MinerNamesRepository();
