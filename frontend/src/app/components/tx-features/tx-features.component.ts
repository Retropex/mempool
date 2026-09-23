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
  // 'all': at least one parsed signature opts in to SIGHASH_UNIFIED (0x20),
  // so the transaction is invalid on any chain without the hardfork.
  // 'partial': currently unused. 'none': no parsed signature opts in.
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
    // A single signature with SIGHASH_UNIFIED (0x20) anywhere in the
    // transaction makes the whole transaction invalid under the pre-fork
    // rules: every input must validate, and in a multisig every provided
    // signature must verify. So one opted-in signature is enough.
    let parsed = 0;
    for (const vin of this.tx.vin) {
      let sigs;
      try { sigs = processInputSignatures(vin); } catch { sigs = []; }
      if (!sigs?.length) { continue; }
      parsed++;
      if (sigs.some(sig => (sig.sighash & 0x20) !== 0)) { return 'all'; }
    }
    return parsed ? 'none' : 'unknown';
  }
}
