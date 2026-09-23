import DB from '../database';
import databaseMigration from '../api/database-migration';
import { Common } from '../api/common';
import { cleanupTestData, insertTestBlock, setupTestDatabase, waitForDatabase } from './test-helpers';

describe('Database Migration Integration Tests', () => {
  beforeAll(async () => {
    await waitForDatabase();
    await setupTestDatabase();
  }, 120000);

  test('should create state table', async () => {
    const [result] = await DB.query<any>(
      `SELECT COUNT(*) as count 
       FROM information_schema.tables 
       WHERE table_schema = 'mempool_test' 
       AND table_name = 'state'`
    );
    expect(result[0].count).toBe(1);
  });

  test('should have schema version in state table', async () => {
    const [result] = await DB.query<any>('SELECT number FROM state WHERE name = \'schema_version\'');
    expect(result).toHaveLength(1);
    expect(result[0].number).toBeGreaterThan(0);
  });

  test('should create blocks table', async () => {
    const [result] = await DB.query<any>(
      `SELECT COUNT(*) as count 
       FROM information_schema.tables 
       WHERE table_schema = 'mempool_test' 
       AND table_name = 'blocks'`
    );
    expect(result[0].count).toBe(1);
  });

  test('should create pools table', async () => {
    const [result] = await DB.query<any>(
      `SELECT COUNT(*) as count 
       FROM information_schema.tables 
       WHERE table_schema = 'mempool_test' 
       AND table_name = 'pools'`
    );
    expect(result[0].count).toBe(1);
  });

  test('should create hashrates table', async () => {
    const [result] = await DB.query<any>(
      `SELECT COUNT(*) as count 
       FROM information_schema.tables 
       WHERE table_schema = 'mempool_test' 
       AND table_name = 'hashrates'`
    );
    expect(result[0].count).toBe(1);
  });

  test('should create prices table', async () => {
    const [result] = await DB.query<any>(
      `SELECT COUNT(*) as count 
       FROM information_schema.tables 
       WHERE table_schema = 'mempool_test' 
       AND table_name = 'prices'`
    );
    expect(result[0].count).toBe(1);
  });

  test('blocks table should have required columns', async () => {
    const [columns] = await DB.query<any>(
      `SELECT COLUMN_NAME 
       FROM information_schema.COLUMNS 
       WHERE TABLE_SCHEMA = 'mempool_test' 
       AND TABLE_NAME = 'blocks'`
    );

    const columnNames = columns.map((col: any) => col.COLUMN_NAME);
    expect(columnNames).toContain('height');
    expect(columnNames).toContain('hash');
    expect(columnNames).toContain('blockTimestamp');
    expect(columnNames).toContain('size');
    expect(columnNames).toContain('weight');
    expect(columnNames).toContain('tx_count');
  });

  test('pools table should have required columns', async () => {
    const [columns] = await DB.query<any>(
      `SELECT COLUMN_NAME 
       FROM information_schema.COLUMNS 
       WHERE TABLE_SCHEMA = 'mempool_test' 
       AND TABLE_NAME = 'pools'`
    );

    const columnNames = columns.map((col: any) => col.COLUMN_NAME);
    expect(columnNames).toContain('id');
    expect(columnNames).toContain('name');
    expect(columnNames).toContain('slug');
  });

  describe('migration 117: BLAKE2b blocks saved with a SHA256d-style difficulty', () => {
    // Serialized headers as stored in `blocks.header`: a legacy header is 80 bytes with the top version bit clear,
    // a BLAKE2b header v2 is 164 bytes with the top version bit set (mainnet #961639 and #961640 respectively)
    const legacyHeader = (tail: string): string => ('10000a20' + tail).padEnd(160, '0');
    const v2Header = (tail: string): string => ('000000a0' + tail).padEnd(328, '0');
    const hash = (n: number): string => n.toString(16).padStart(64, '0');
    const legacyDifficulty = (bits: number): number => {
      // The SHA256d formula, i.e. what Bitcoin Knots < v29.4.2 and esplora report for a BLAKE2b block
      const exponent = bits >>> 24;
      const mantissa = bits & 0x00ffffff;
      return (0xffff * Math.pow(256, 0x1d - 3)) / (mantissa * Math.pow(256, exponent - 3));
    };

    const rows = [
      // SHA256d blocks, must not change
      { height: 961632, bits: 0x1702353d, header: legacyHeader('01'), difficulty: 127479855693691.4, stale: false },
      { height: 961639, bits: 0x1702353d, header: legacyHeader('02'), difficulty: 127479855693691.4, stale: false },
      // BLAKE2b blocks indexed under Bitcoin Knots < v29.4.2, saved with the SHA256d formula
      { height: 961640, bits: 0x1a008d4f, header: v2Header('03'), difficulty: legacyDifficulty(0x1a008d4f), stale: false },
      { height: 965664, bits: 0x193c2d40, header: v2Header('04'), difficulty: legacyDifficulty(0x193c2d40), stale: false },
      { height: 965664, bits: 0x193c2d40, header: v2Header('05'), difficulty: legacyDifficulty(0x193c2d40), stale: true },
      { height: 973163, bits: 0x190141c0, header: v2Header('06'), difficulty: legacyDifficulty(0x190141c0), stale: false },
      // BLAKE2b block indexed under Bitcoin Knots v29.4.2, already in the new unit as printed by the RPC
      { height: 973164, bits: 0x190141c0, header: v2Header('07'), difficulty: 14677129705888560000, stale: false },
      // Look-alikes: a legacy-length header with the top bit set, a v2-length header without it
      { height: 500001, bits: 0x1802aaaa, header: '000000a0'.padEnd(160, '0'), difficulty: 111.5, stale: false },
      { height: 500002, bits: 0x1802bbbb, header: '10000a20'.padEnd(328, '0'), difficulty: 222.5, stale: false },
    ];
    const adjustments = [
      { height: 961632, difficulty: 127479855693691.4, adjustment: 1.5 },
      { height: 961640, difficulty: legacyDifficulty(0x1a008d4f), adjustment: 0 },
      { height: 965664, difficulty: legacyDifficulty(0x193c2d40), adjustment: 4 },
    ];

    const getBlocks = async (): Promise<{ height: number; hash: string; bits: number; difficulty: number }[]> => {
      const [result] = await DB.query<any>('SELECT height, hash, bits, difficulty FROM blocks ORDER BY hash');
      return result;
    };
    const getAdjustments = async (): Promise<{ height: number; difficulty: number; adjustment: number }[]> => {
      const [result] = await DB.query<any>('SELECT height, difficulty, adjustment FROM difficulty_adjustments ORDER BY height');
      return result;
    };
    const runMigrationFrom = async (version: number): Promise<void> => {
      await DB.query('UPDATE state SET number = ? WHERE name = \'schema_version\'', [version]);
      await databaseMigration.$initializeOrMigrateDatabase();
    };

    beforeAll(async () => {
      await cleanupTestData();
      for (const [i, row] of rows.entries()) {
        await insertTestBlock({ ...row, hash: hash(i + 1), blockTimestamp: new Date(1700000000000 + row.height * 1000) });
      }
      for (const adjustment of adjustments) {
        await DB.query(
          'INSERT INTO difficulty_adjustments (time, height, difficulty, adjustment) VALUES (FROM_UNIXTIME(?), ?, ?, ?)',
          [1700000000 + adjustment.height, adjustment.height, adjustment.difficulty, adjustment.adjustment]
        );
      }
      await runMigrationFrom(116);
    }, 60000);

    afterAll(async () => {
      await cleanupTestData();
    });

    test('should rewrite BLAKE2b blocks as difficulty_blake2b, whichever unit they were saved in', async () => {
      const blocks = await getBlocks();
      for (const block of blocks.filter(b => [961640, 965664, 973163, 973164].includes(b.height))) {
        expect(block.difficulty).toBe(Common.getBlake2bDifficulty(block.bits));
      }
      // Both sides of the seam now hold the same value, matching `difficulty_blake2b` from Bitcoin Knots v29.4.2
      const seam = blocks.filter(b => [973163, 973164].includes(b.height));
      expect(seam).toHaveLength(2);
      expect(seam[0].difficulty).toBe(seam[1].difficulty);
      expect(seam[0].difficulty.toPrecision(16)).toBe('1.467712970588856e+19');
    });

    test('should leave SHA256d blocks alone', async () => {
      const blocks = await getBlocks();
      for (const block of blocks.filter(b => [961632, 961639].includes(b.height))) {
        expect(block.difficulty).toBe(127479855693691.4);
      }
    });

    test('should only select header v2 blocks: 164-byte header with the top version bit set', async () => {
      const blocks = await getBlocks();
      expect(blocks.find(b => b.height === 500001)?.difficulty).toBe(111.5);
      expect(blocks.find(b => b.height === 500002)?.difficulty).toBe(222.5);
    });

    test('should copy the new difficulty to difficulty_adjustments and keep the adjustment ratios', async () => {
      const result = await getAdjustments();
      expect(result).toEqual([
        { height: 961632, difficulty: 127479855693691.4, adjustment: 1.5 },
        { height: 961640, difficulty: Common.getBlake2bDifficulty(0x1a008d4f), adjustment: 0 },
        { height: 965664, difficulty: Common.getBlake2bDifficulty(0x193c2d40), adjustment: 4 },
      ]);
    });

    test('should update the schema version', async () => {
      const [result] = await DB.query<any>('SELECT number FROM state WHERE name = \'schema_version\'');
      expect(result[0].number).toBeGreaterThanOrEqual(117);
    });

    test('should be idempotent', async () => {
      const blocksBefore = await getBlocks();
      const adjustmentsBefore = await getAdjustments();
      await runMigrationFrom(116);
      expect(await getBlocks()).toEqual(blocksBefore);
      expect(await getAdjustments()).toEqual(adjustmentsBefore);
    });
  });
});

