import { Injectable } from '@angular/core';
import { Observable, of } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';

export interface OceanTemplateStats {
  template: string;
  shares: number;
  percentage: number;
}

export interface OceanHashrateData {
  templates: OceanTemplateStats[];
  totalShares: number;
  timestamp: number;
  lastUpdated: number;
}

@Injectable({
  providedIn: 'root'
})
export class OceanService {
  private cache: {
    lastUpdated: number;
    data: OceanHashrateData;
  } | null = null;
  
  private readonly CACHE_DURATION = 2 * 60 * 1000; // 2 minutes

  constructor(private http: HttpClient) {}

  getHashrateDistribution(): Observable<OceanHashrateData> {
    // Check cache first
    const now = Date.now();
    if (this.cache && 
        this.cache.lastUpdated && 
        (now - this.cache.lastUpdated) < this.CACHE_DURATION) {
      return of(this.cache.data);
    }

    return this.http.get<OceanHashrateData>('/api/v1/ocean/hashrate-stats')
      .pipe(
        tap((data) => {
          this.cache = {
            lastUpdated: now,
            data: data
          };
        }),
        catchError((error: HttpErrorResponse) => {
          console.error('Error fetching Ocean hashrate data:', error);
          // Return cached data if available, otherwise empty data
          if (this.cache && this.cache.data) {
            return of(this.cache.data);
          }
          throw error;
        })
      );
  }

  getTotalShares(data: OceanHashrateData): number {
    return data.totalShares;
  }
}
