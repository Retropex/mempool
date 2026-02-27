import { Injectable } from '@angular/core';

/**
 * BIP110 (Reduced Data Temporary Softfork) Service
 * 
 * Provides utilities for detecting and displaying BIP110-related information:
 * - Miner signaling detection (deployment 'reduced_data', version bit 4, 55% threshold)
 * - Transaction violation flags for all 7 BIP110 consensus rules
 * 
 * See bip-0110.mediawiki for the full specification.
 * 
 * NOTE: Uses BigInt for all flag operations because flags use bits 35-41,
 * which exceed JavaScript's 32-bit limit for bitwise operators.
 */
@Injectable({
  providedIn: 'root'
})
export class Bip110Service {
  static readonly VERSION_BIT = 4;


  /**
   * Check if block version signals BIP110 support
   */
  isSignaling(version: number): boolean {
    return (version & (1 << Bip110Service.VERSION_BIT)) !== 0;
  }
}
