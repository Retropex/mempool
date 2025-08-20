import { Injectable } from '@angular/core';
import { Observable, of } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';

export interface KnotsNodeStats {
  country: string;
  count: number;
  percentage: number;
}

@Injectable({
  providedIn: 'root'
})
export class BitnodesService {
  private cache: {
    lastUpdated: number;
    data: KnotsNodeStats[];
  } | null = null;
  
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

  constructor(
    private http: HttpClient
  ) {}

  /**
   * Get Knots nodes distribution by country
   */
  getKnotsNodeDistribution(): Observable<KnotsNodeStats[]> {
    // Check cache first
    if (this.cache && (Date.now() - this.cache.lastUpdated) < this.CACHE_DURATION) {
      return of(this.cache.data);
    }

    // Always use our backend endpoint to avoid CORS issues
    const apiUrl = '/api/v1/bitnodes/knots-stats';

    return this.http.get<KnotsNodeStats[]>(apiUrl)
      .pipe(
        tap(data => {
          this.cache = {
            lastUpdated: Date.now(),
            data
          };
        }),
        catchError((error: HttpErrorResponse) => {
          console.error('Error fetching Bitnodes data:', error);
          return of([]);
        })
      );
  }
}
