import logger from '../logger';
import blocks from './blocks';
import bitcoinApiFactory from './bitcoin/bitcoin-api-factory';
import { Common } from './common';

/**
 * BIP-110 'reduced_data' deployment state tracker.
 *
 * Computes the deployment phase from the current chain tip and signaling data,
 * using the constants defined in bip-0110.mediawiki:
 *
 *   bit:                    4
 *   starttime:              1764547200 (~December 1, 2025)
 *   threshold:              1109/2016 (55%)
 *   max_activation_height:  965664
 *   active_duration:        52416 blocks (~1 year)
 *   mandatory signaling:    blocks 961632–963647
 *   mandatory lock-in:      height 963648
 *
 * State machine: DEFINED → STARTED → LOCKED_IN → ACTIVE
 */

// ── BIP-110 deployment constants ──────────────────────────────────────────────
const RETARGET_PERIOD = 2016;
const THRESHOLD = 1109;                           // 55% of 2016
const STARTTIME = 1764547200;                     // MTP threshold for DEFINED→STARTED
const MANDATORY_SIGNALING_START = 961632;         // first block of mandatory signaling period
const MANDATORY_LOCK_IN_HEIGHT = 963648;          // forced LOCKED_IN if threshold not reached earlier
const MAX_ACTIVATION_HEIGHT = 965664;             // ACTIVE starts here if locked in at mandatory
const ACTIVE_DURATION = 52416;                    // rules enforced for this many blocks after activation

export type Bip110State = 'defined' | 'started' | 'locked_in' | 'active';

export interface Bip110DeploymentInfo {
  /** Current deployment state */
  state: Bip110State;
  /** Current chain tip height */
  currentHeight: number;

  // ── STARTED phase info ──────────────────────────────────────────────────
  /** Signaling blocks in the current retarget period */
  periodSignaling: number;
  /** Total blocks mined so far in the current retarget period */
  periodBlocks: number;
  /** Height of the first block of the current retarget period */
  periodStartHeight: number;
  /** Threshold needed (1109) */
  threshold: number;
  /** Signaling percentage in current period (0–100) */
  signalingPercent: number;
  /** Whether threshold has been reached in the current period */
  thresholdReached: boolean;

  // ── Countdown / milestone info ──────────────────────────────────────────
  /** Blocks remaining until mandatory signaling period begins */
  blocksUntilMandatory: number;
  /** Whether the current block is in the mandatory signaling window */
  inMandatorySignaling: boolean;
  /** Height at which the soft fork rules will activate (or did activate) */
  activationHeight: number | null;
  /** Height at which active_duration expires (rules stop being enforced) */
  expiryHeight: number | null;
  /** Blocks remaining in the active enforcement period (0 if not active or expired) */
  blocksUntilExpiry: number;
  /** Whether the rules have expired (active_duration elapsed) */
  rulesExpired: boolean;
}

class Bip110DeploymentApi {
  private cachedInfo: Bip110DeploymentInfo | null = null;
  private lastHeight: number = -1;
  /** Height at which LOCKED_IN was entered (if we know it) */
  private lockedInHeight: number | null = null;

  /**
   * Get the current deployment info. Recomputes only when chain tip changes.
   */
  public async getDeploymentInfo(): Promise<Bip110DeploymentInfo | null> {
    const currentHeight = blocks.getCurrentBlockHeight();
    if (currentHeight < 0) {
      return null;
    }
    if (currentHeight !== this.lastHeight || !this.cachedInfo) {
      this.cachedInfo = await this.computeDeploymentInfo(currentHeight);
      this.lastHeight = currentHeight;
    }
    return this.cachedInfo;
  }

  /**
   * Compute the full deployment state for a given chain tip height.
   */
  private async computeDeploymentInfo(currentHeight: number): Promise<Bip110DeploymentInfo> {
    const state = this.computeState(currentHeight);

    // Current retarget period signaling stats
    const periodStartHeight = currentHeight - (currentHeight % RETARGET_PERIOD);
    const periodBlocks = (currentHeight % RETARGET_PERIOD) + 1;

    // Count signaling blocks in the current retarget period from the in-memory block cache
    const periodSignaling = await this.countSignalingInCurrentPeriod(periodStartHeight, currentHeight);
    const signalingPercent = periodBlocks > 0 ? (periodSignaling / periodBlocks) * 100 : 0;
    const thresholdReached = periodSignaling >= THRESHOLD;

    // Milestone computations
    const blocksUntilMandatory = Math.max(0, MANDATORY_SIGNALING_START - currentHeight);
    const inMandatorySignaling = currentHeight >= MANDATORY_SIGNALING_START && currentHeight < MANDATORY_LOCK_IN_HEIGHT;

    // Activation height: computed from when lock-in occurred
    let activationHeight: number | null = null;
    if (state === 'locked_in' || state === 'active') {
      if (this.lockedInHeight != null) {
        // Activation is at the start of the next retarget period after lock-in
        const lockInPeriodStart = this.lockedInHeight - (this.lockedInHeight % RETARGET_PERIOD);
        activationHeight = lockInPeriodStart + RETARGET_PERIOD;
      } else {
        // Fallback: use MAX_ACTIVATION_HEIGHT (mandatory lock-in case)
        activationHeight = MAX_ACTIVATION_HEIGHT;
      }
    }

    const expiryHeight = activationHeight != null ? activationHeight + ACTIVE_DURATION : null;
    const blocksUntilExpiry = expiryHeight != null && state === 'active'
      ? Math.max(0, expiryHeight - currentHeight)
      : 0;
    const rulesExpired = state === 'active' && expiryHeight != null && currentHeight >= expiryHeight;

    return {
      state,
      currentHeight,
      periodSignaling,
      periodBlocks,
      periodStartHeight,
      threshold: THRESHOLD,
      signalingPercent,
      thresholdReached,
      blocksUntilMandatory,
      inMandatorySignaling,
      activationHeight,
      expiryHeight,
      blocksUntilExpiry,
      rulesExpired,
    };
  }

  /**
   * Determine the deployment state based on height and known history.
   *
   * State transitions (BIP-110):
   *   DEFINED  →  block.MTP ≥ starttime  →  STARTED
   *   STARTED  →  threshold reached OR height ≥ 963648  →  LOCKED_IN
   *   LOCKED_IN →  next retarget boundary  →  ACTIVE
   *
   * Since we can't cheaply compute MTP, we use block timestamps from the cache
   * as a reasonable approximation. The DEFINED→STARTED transition only matters
   * for blocks near the starttime (~Dec 2025). After that, height-based logic
   * dominates.
   */
  private computeState(currentHeight: number): Bip110State {
    // Check if we've already passed LOCKED_IN or ACTIVE thresholds
    if (this.lockedInHeight != null) {
      const lockInPeriodStart = this.lockedInHeight - (this.lockedInHeight % RETARGET_PERIOD);
      const activationHeight = lockInPeriodStart + RETARGET_PERIOD;
      if (currentHeight >= activationHeight) {
        return 'active';
      }
      return 'locked_in';
    }

    // Height >= mandatory lock-in height means at least LOCKED_IN
    if (currentHeight >= MANDATORY_LOCK_IN_HEIGHT) {
      // Must be LOCKED_IN or ACTIVE
      this.lockedInHeight = MANDATORY_LOCK_IN_HEIGHT;
      const lockInPeriodStart = MANDATORY_LOCK_IN_HEIGHT - (MANDATORY_LOCK_IN_HEIGHT % RETARGET_PERIOD);
      const activationHeight = lockInPeriodStart + RETARGET_PERIOD;
      if (currentHeight >= activationHeight) {
        return 'active';
      }
      return 'locked_in';
    }

    // Before starttime → DEFINED
    // Use the latest block timestamp as a proxy for MTP
    const latestBlocks = blocks.getBlocks();
    const latestBlock = latestBlocks.length > 0 ? latestBlocks[latestBlocks.length - 1] : null;
    if (latestBlock && latestBlock.timestamp < STARTTIME) {
      return 'defined';
    }

    // If we can't determine (no blocks yet), assume DEFINED
    if (!latestBlock) {
      return 'defined';
    }

    // We're in STARTED state — check if threshold was reached at the end of
    // the most recent completed retarget period
    // (In practice, we'd need to scan historical retarget periods, but for
    //  a live dashboard, we check the current period's signaling progress.)
    return 'started';
  }

  /**
   * Called when a new block arrives. If we detect threshold reached at a
   * retarget boundary, record the lock-in height.
   */
  public async onNewBlock(height: number): Promise<void> {
    if (this.lockedInHeight != null) {
      return; // Already locked in
    }

    // Check if this block is the last block of a retarget period
    const posInPeriod = height % RETARGET_PERIOD;
    if (posInPeriod === RETARGET_PERIOD - 1) {
      const periodStart = height - posInPeriod;
      const signaling = await this.countSignalingInCurrentPeriod(periodStart, height);
      if (signaling >= THRESHOLD) {
        this.lockedInHeight = height + 1; // Lock-in happens at the next retarget boundary
        logger.info(`BIP-110: Threshold reached at height ${height} (${signaling}/${RETARGET_PERIOD}). LOCKED_IN at ${this.lockedInHeight}.`);
      }
    }

    // Clear cached info so it's recomputed
    this.lastHeight = -1;
    this.cachedInfo = null;
  }

  /**
   * Count signaling blocks in the current retarget period using the in-memory
   * block cache. Falls back to 0 if blocks aren't in memory.
   */
  private async countSignalingInCurrentPeriod(periodStart: number, currentHeight: number): Promise<number> {
    let count = 0;
    let hash, blockdata;
    for (let i = currentHeight; i >= periodStart; i--){
      hash = await bitcoinApiFactory.$getBlockHash(i);
      blockdata = await blocks.$getBlock(hash);
      if (Common.isSignalingBIP110(blockdata.version)){
        count++;
      }
    }
    return count;
  }
}

export default new Bip110DeploymentApi();
