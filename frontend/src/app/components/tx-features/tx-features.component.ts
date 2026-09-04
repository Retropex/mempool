import { Component, ChangeDetectionStrategy, OnChanges, Input } from '@angular/core';
import { calcSegwitFeeGains, isFeatureActive } from '@app/bitcoin.utils';
import { Transaction } from '@interfaces/electrs.interface';
import { StateService } from '@app/services/state.service';
import { processInputSignatures } from '@app/shared/transaction.utils';

@Component({
  selector: 'app-tx-features',
  templateUrl: './tx-features.component.html',
  styleUrls: ['./tx-features.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TxFeaturesComponent implements OnChanges {
  @Input() tx: Transaction;

  segwitGains = {
    realizedSegwitGains: 0,
    potentialSegwitGains: 0,
    potentialP2shSegwitGains: 0,
    potentialTaprootGains: 0,
    realizedTaprootGains: 0
  };
  isRbfTransaction: boolean;
  isTaproot: boolean;
  // 'all': every parsed signature opts in to SIGHASH_UNIFIED (0x20), so the
  // transaction is invalid on any chain without the hardfork.
  // 'partial': some inputs opt in, some do not. 'none': no input opts in.
  // 'unknown': no signatures could be parsed (e.g. unsupported script types).
  replayProtection: 'all' | 'partial' | 'none' | 'unknown' = 'unknown';
  unifiedEnabled: boolean;

  segwitEnabled: boolean;
  rbfEnabled: boolean;
  taprootEnabled: boolean;

  constructor(
    private stateService: StateService,
  ) { }

  ngOnChanges() {
    if (!this.tx) {
      return;
    }
    this.segwitEnabled = !this.tx.status.confirmed || isFeatureActive(this.stateService.network, this.tx.status.block_height, 'segwit');
    this.taprootEnabled = !this.tx.status.confirmed || isFeatureActive(this.stateService.network, this.tx.status.block_height, 'taproot');
    this.rbfEnabled = !this.tx.status.confirmed || isFeatureActive(this.stateService.network, this.tx.status.block_height, 'rbf');
    this.segwitGains = calcSegwitFeeGains(this.tx);
    this.isRbfTransaction = this.tx.vin.some((v) => v.sequence < 0xfffffffe);
    this.isTaproot = this.tx.vin.some((v) => v.prevout && v.prevout.scriptpubkey_type === 'v1_p2tr');
    this.unifiedEnabled = !this.tx.vin[0]?.is_coinbase
      && (!this.tx.status.confirmed || isFeatureActive(this.stateService.network, this.tx.status.block_height, 'unified'));
    this.replayProtection = this.unifiedEnabled ? this.classifyReplayProtection() : 'unknown';
  }

  private classifyReplayProtection(): 'all' | 'partial' | 'none' | 'unknown' {
    let optedIn = 0;
    let legacy = 0;
    for (const vin of this.tx.vin) {
      let sigs;
      try { sigs = processInputSignatures(vin); } catch { sigs = []; }
      if (!sigs?.length) { continue; }
      if (sigs.every(sig => (sig.sighash & 0x20) !== 0)) { optedIn++; } else { legacy++; }
    }
    if (!optedIn && !legacy) { return 'unknown'; }
    if (!legacy) { return 'all'; }
    if (!optedIn) { return 'none'; }
    return 'partial';
  }
}
