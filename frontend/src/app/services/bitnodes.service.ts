import { Injectable } from '@angular/core';
import { Observable, of } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';

export interface KnotsNodeStats {
  country: string;
  count: number;
  percentage: number;
}

export interface KnotsNodeTotals {
  totalNodes: number;
  clearnetNodes: number;
  torNodes: number;
  totalBitcoinNodes: number;
  percentageOfTotal: number;
  bipCount: number;
}

export interface KnotsNodeResponse {
  countries: KnotsNodeStats[];
  totals: KnotsNodeTotals;
}

@Injectable({
  providedIn: 'root'
})
export class BitnodesService {
  private cache: {
    lastUpdated: number;
    data: KnotsNodeResponse;
  } | null = null;
  
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

  constructor(
    private http: HttpClient
  ) {}

  /**
   * Get Knots nodes distribution by country
   */
  getKnotsNodeDistribution(): Observable<KnotsNodeResponse> {
    // Check cache first
    if (this.cache && (Date.now() - this.cache.lastUpdated) < this.CACHE_DURATION) {
      return of(this.cache.data);
    }

    // Always use our backend endpoint to avoid CORS issues
    const apiUrl = '/api/v1/bitnodes/knots-stats';

    return this.http.get<KnotsNodeResponse>(apiUrl)
      .pipe(
        tap(data => {
          this.cache = {
            lastUpdated: Date.now(),
            data
          };
        }),
        catchError((error: HttpErrorResponse) => {
          console.error('Error fetching Bitnodes data:', error);
          return of({
            countries: [],
            totals: { 
              totalNodes: 0, 
              clearnetNodes: 0, 
              torNodes: 0,
              totalBitcoinNodes: 0,
              percentageOfTotal: 0,
              bipCount: 0,
            }
          });
        })
      );
  }
}
