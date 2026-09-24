import { ChangeDetectionStrategy, Component, Input, NgZone, OnInit, HostBinding } from '@angular/core';
import { UntypedFormBuilder, UntypedFormGroup } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { EChartsOption, PieSeriesOption } from '@app/graphs/echarts';
import { merge, Observable } from 'rxjs';
import { map, shareReplay, startWith, switchMap, tap } from 'rxjs/operators';
import { SeoService } from '@app/services/seo.service';
import { StorageService } from '@app//services/storage.service';
import { MiningService, MiningStats } from '@app/services/mining.service';
import { StateService } from '@app/services/state.service';
import { originalChartColors as chartColors, poolsColor } from '@app/app.constants';
import { RelativeUrlPipe } from '@app/shared/pipes/relative-url/relative-url.pipe';
import { download } from '@app/shared/graphs.utils';
import { isMobile } from '@app/shared/common.utils';

/** One arc band of a pool's slice: the blocks one DATUM miner built templates for */
interface MinerBand {
  name: string;
  blockCount: number;
  poolName: string;
  poolShare: string;
  color: string;
  /** Where the band sits around the pie, as a share of a full turn from twelve o'clock */
  startAngle: number;
  endAngle: number;
  /** Where the band sits across the depth of the wedge, 0 at the hole and 1 at the rim */
  innerRadius: number;
  outerRadius: number;
  value: number;
  /** The pool's slug, which is what the chart's click handler navigates by */
  data: string;
}

@Component({
  selector: 'app-pool-ranking',
  templateUrl: './pool-ranking.component.html',
  styleUrls: ['./pool-ranking.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PoolRankingComponent implements OnInit {
  @Input() height: number = 300;
  @Input() widget = false;

  miningWindowPreference: string;
  radioGroupForm: UntypedFormGroup;

  auditAvailable = false;
  indexingAvailable = false;
  isLoading = true;
  chartOptions: EChartsOption = {};
  chartInitOptions = {
    renderer: 'svg',
  };
  timespan = '';
  chartInstance: any = undefined;

  /** The palette ECharts assigns pool slices from; yellow is reserved for the 'unknown' pool */
  private static readonly SERIES_COLORS = chartColors.filter(color => color !== '#FDD835');
  /** At most this many miners get their own band in a pool's slice */
  private static readonly MAX_MINER_BANDS = 8;
  /** Thinnest band a slice will draw, as a share of the depth of its wedge */
  private static readonly MIN_BAND_DEPTH = 0.08;
  /**
   * Lightness the first band is drawn at and the floor the last one darkens to. The floor is
   * what keeps the deepest palette colours (navy, indigo, purple) off the page background: at
   * their own lightness those bands are all but invisible on it.
   */
  private static readonly BAND_LIGHTEST = 0.84;
  private static readonly BAND_DARKEST = 0.58;

  @HostBinding('attr.dir') dir = 'ltr';

  miningStatsObservable$: Observable<MiningStats>;

  constructor(
    public stateService: StateService,
    private storageService: StorageService,
    private formBuilder: UntypedFormBuilder,
    private miningService: MiningService,
    private seoService: SeoService,
    private router: Router,
    private zone: NgZone,
    private route: ActivatedRoute,
  ) {
  }

  ngOnInit(): void {
    if (this.widget) {
      this.miningWindowPreference = '1w';
    } else {
      this.seoService.setTitle($localize`:@@fe5317c6c60dd7e0e86f04d22f566f67cf04d404:Mining Pools`);
      this.seoService.setDescription($localize`:@@meta.description.bitcoin.graphs.pool-ranking:See the top Bitcoin mining pools ranked by number of blocks mined, over your desired timeframe.`);
      this.miningWindowPreference = this.miningService.getDefaultTimespan('24h');
    }
    this.radioGroupForm = this.formBuilder.group({ dateSpan: this.miningWindowPreference });
    this.radioGroupForm.controls.dateSpan.setValue(this.miningWindowPreference);

    this.indexingAvailable = (this.stateService.env.BASE_MODULE === 'mempool' &&
      this.stateService.env.MINING_DASHBOARD === true);
    this.auditAvailable = this.indexingAvailable && this.stateService.env.AUDIT;

    this.route
      .fragment
      .subscribe((fragment) => {
        if (['24h', '3d', '1w', '1m', '3m', '6m', '1y', '2y', '3y', 'all'].indexOf(fragment) > -1) {
          this.radioGroupForm.controls.dateSpan.setValue(fragment, { emitEvent: false });
        }
      });

    this.miningStatsObservable$ = merge(
      this.radioGroupForm.get('dateSpan').valueChanges
        .pipe(
          startWith(this.radioGroupForm.controls.dateSpan.value), // (trigger when the page loads)
          tap((value) => {
            this.isLoading = true;
            this.timespan = value;
            if (!this.widget) {
              this.storageService.setValue('miningWindowPreference', value);
            }
            this.miningWindowPreference = value;
          }),
          switchMap(() => {
            return this.miningService.getMiningStats(this.miningWindowPreference);
          })
        ),
        this.stateService.chainTip$
          .pipe(
            switchMap(() => {
              return this.miningService.getMiningStats(this.miningWindowPreference);
            })
          )
      )
      .pipe(
        map(data => {
          data['minersLuck'] = (100 * (data.blockCount / 1008)).toFixed(2); // luck 1w
          return data;
        }),
        tap(data => {
          this.isLoading = false;
          this.prepareChartOptions(data);
        }),
        shareReplay(1)
      );
  }

  generateChartSeriesData(miningStats): { pools: object[], bands: MinerBand[] } {
    let poolShareThreshold = 0;
    if (isMobile()) {
      poolShareThreshold = 0;
    } else if (this.widget) {
      poolShareThreshold = 0;
    }

    const data: object[] = [];
    // the pool behind each slice, in serie order, so the miner bands can be laid over the
    // slices once the whole pie is known and its angles can be worked out
    const sources: ({ pool, color: string } | null)[] = [];
    // ECharts hands out palette colours in serie order, skipping the slices that name their
    // own. Assigning them here instead keeps that same order while letting a pool's miner
    // bands be shaded from the colour its slice ends up with.
    let paletteIndex = 0;
    let totalShareOther = 0;
    let totalBlockOther = 0;
    let totalEstimatedHashrateOther = 0;

    let edgeDistance: any = '20%';
    if (isMobile() && this.widget) {
      edgeDistance = 0;
    } else if (isMobile() && !this.widget || this.widget) {
      edgeDistance = 10;
    }

    miningStats.pools.forEach((pool) => {
      if (parseFloat(pool.share) < poolShareThreshold) {
        totalShareOther += parseFloat(pool.share);
        totalBlockOther += pool.blockCount;
        totalEstimatedHashrateOther += pool.lastEstimatedHashrate;
        return;
      }
      const poolColor = poolsColor[pool.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()]
        ?? PoolRankingComponent.SERIES_COLORS[paletteIndex++ % PoolRankingComponent.SERIES_COLORS.length];
      sources.push({ pool, color: poolColor });
      data.push({
        itemStyle: {
          color: poolColor,
        },
        value: pool.share,
        name: pool.name + ((isMobile() || this.widget) ? `` : ` (${pool.share}%)`),
        label: {
          overflow: 'none',
          color: 'var(--grey)',
          alignTo: 'edge',
          edgeDistance: edgeDistance,
        },
        tooltip: {
          show: !isMobile() || !this.widget,
          backgroundColor: 'rgba(17, 19, 31, 1)',
          borderRadius: 4,
          shadowColor: 'rgba(0, 0, 0, 0.5)',
          textStyle: {
            color: 'var(--tooltip-grey)',
          },
          borderColor: '#000',
          formatter: () => {
            const i = pool.blockCount.toString();
            if (['24h', '3d', '1w'].includes(this.miningWindowPreference)) {
              let hashrate = pool.lastEstimatedHashrate;
              if ('3d' === this.miningWindowPreference) { hashrate = pool.lastEstimatedHashrate3d; }
              if ('1w' === this.miningWindowPreference) { hashrate = pool.lastEstimatedHashrate1w; }
              return `<b style="color: white">${pool.name} (${pool.share}%)</b><br>` +
                hashrate.toFixed(2) + ' ' + miningStats.miningUnits.hashrateUnit +
                `<br>` + $localize`${ i }:INTERPOLATION: blocks`;
            } else {
              return `<b style="color: white">${pool.name} (${pool.share}%)</b><br>` +
                $localize`${ i }:INTERPOLATION: blocks`;
            }
          }
        },
        data: pool.slug,
      } as PieSeriesOption);
    });

    const percentage = totalShareOther.toFixed(2) + '%';

    // 'Other' aggregates pools below the threshold, none of which is broken down by miner
    sources.push(null);
    data.push({
      itemStyle: {
        color: '#6b6b6b',
      },
      value: totalShareOther,
      name:  $localize`Other (${percentage})`,
      label: {
        overflow: 'none',
        color: 'var(--grey)',
        alignTo: 'edge',
        edgeDistance: edgeDistance
      },
      tooltip: {
        backgroundColor: 'rgba(17, 19, 31, 1)',
        borderRadius: 4,
        shadowColor: 'rgba(0, 0, 0, 0.5)',
        textStyle: {
          color: 'var(--tooltip-grey)',
        },
        borderColor: '#000',
        formatter: () => {
          const i = totalBlockOther.toString();
          if (['24h', '3d', '1w'].includes(this.miningWindowPreference)) {
            return `<b style="color: white">` + $localize`Other (${percentage})` + `</b><br>` + totalEstimatedHashrateOther.toFixed(2) + ' ' + miningStats.miningUnits.hashrateUnit + `<br>` + $localize`${ i }:INTERPOLATION: blocks`;
          } else {
            return `<b style="color: white">` + $localize`Other (${percentage})` + `</b><br>` + $localize`${ i }:INTERPOLATION: blocks`;
          }
        }
      },
      data: 9999 as any,
    } as PieSeriesOption);

    return { pools: data, bands: this.generateMinerBands(data, sources) };
  }

  /**
   * Lay the miner bands over the slices of a finished pie.
   *
   * A slice's angles are not known until the whole serie is, since ECharts scales them by the
   * serie's own total rather than by an assumed 100%, so this runs as a second pass and
   * measures each slice the way the pie itself does: from twelve o'clock, clockwise, each slice
   * taking its value's share of that total.
   */
  private generateMinerBands(pies: object[], sources: ({ pool, color: string } | null)[]): MinerBand[] {
    const total = pies.reduce((sum, pie) => sum + (parseFloat(pie['value']) || 0), 0);
    if (!total) {
      return [];
    }

    const bands: MinerBand[] = [];
    let cumulative = 0;

    pies.forEach((pie, i) => {
      const startAngle = cumulative / total;
      cumulative += parseFloat(pie['value']) || 0;
      const endAngle = cumulative / total;

      const source = sources[i];
      if (source) {
        bands.push(...this.generateSliceBands(source.pool, source.color, startAngle, endAngle));
      }
    });

    return bands;
  }

  /**
   * Divide one pool's slice into arc bands, one per miner that built its templates through
   * their own DATUM gateway.
   *
   * The slice keeps its angles — the pie is the pie it always was — and it is the depth of the
   * wedge that is shared out, so a pool only two degrees wide still has the full ring to show
   * its miners in. The blocks the pool built itself sit innermost and the miners climb outwards
   * by size, putting the biggest on the rim, which is also where the ring is roomiest.
   *
   * Every band is given a floor of the wedge's depth before the rest is shared out by block
   * count, so no miner is drawn as a hairline; the floors are capped at half the wedge so the
   * bands still visibly differ by size. The tooltip carries the exact block counts.
   */
  private generateSliceBands(pool, poolColor: string, startAngle: number, endAngle: number): MinerBand[] {
    const miners = pool.miners ?? [];
    if (!miners.length || !pool.blockCount || endAngle <= startAngle) {
      return [];
    }

    const shown = miners.slice(0, PoolRankingComponent.MAX_MINER_BANDS);
    const shownBlocks = shown.reduce((sum, miner) => sum + miner.blockCount, 0);
    const otherMinerBlocks = Math.max(0, (pool.minerBlockCount ?? shownBlocks) - shownBlocks);
    const poolBlocks = Math.max(0, pool.blockCount - shownBlocks - otherMinerBlocks);

    // innermost first: the pool's own blocks, then the miners it did not list, then the listed
    // miners smallest to largest, so the biggest gateway ends up on the rim
    const ordered: { name: string, blockCount: number }[] = [];
    if (poolBlocks > 0) {
      ordered.push({ name: $localize`:@@mining.pool-own-template:Built by the pool`, blockCount: poolBlocks });
    }
    if (otherMinerBlocks > 0) {
      ordered.push({ name: $localize`:@@mining.other-miners:Other miners`, blockCount: otherMinerBlocks });
    }
    ordered.push(...shown.slice().reverse());

    const totalBlocks = ordered.reduce((sum, band) => sum + band.blockCount, 0);
    const floor = Math.min(PoolRankingComponent.MIN_BAND_DEPTH, 0.5 / ordered.length);
    const toShare = 1 - floor * ordered.length;
    const lightest = PoolRankingComponent.BAND_LIGHTEST;
    const darkest = PoolRankingComponent.BAND_DARKEST;

    let depth = 0;
    return ordered.map((band, i) => {
      const innerRadius = depth;
      depth += floor + toShare * band.blockCount / totalBlocks;
      return {
        name: band.name,
        blockCount: band.blockCount,
        poolName: pool.name,
        poolShare: (100 * band.blockCount / pool.blockCount).toFixed(1),
        // lightest on the rim, matching the outward climb by size
        color: this.bandColor(poolColor, darkest + (i / Math.max(ordered.length - 1, 1)) * (lightest - darkest)),
        startAngle,
        endAngle,
        innerRadius,
        outerRadius: depth,
        value: band.blockCount,
        data: pool.slug,
      };
    });
  }

  /**
   * Restate a pool's colour at a given lightness, keeping its hue and saturation, so a band
   * still reads as belonging to that pool.
   *
   * The lightness is absolute rather than a shift, because the pool palette runs from bright
   * yellow to near-black: a fixed shift that suits one end leaves the other either washed out
   * or invisible, while a fixed target lands every band in the same readable range.
   */
  private bandColor(color: string, lightness: number): string {
    const hex = color.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const chroma = max - min;
    const saturation = chroma === 0 ? 0 : chroma / (1 - Math.abs(max + min - 1));

    let hue = 0;
    if (chroma !== 0) {
      if (max === r) {
        hue = ((g - b) / chroma) % 6;
      } else if (max === g) {
        hue = (b - r) / chroma + 2;
      } else {
        hue = (r - g) / chroma + 4;
      }
      hue = (hue * 60 + 360) % 360;
    }

    const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = lightness - c / 2;
    const rgb = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x]
      : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];

    return '#' + rgb
      .map((channel) => Math.round((channel + m) * 255).toString(16).padStart(2, '0'))
      .join('');
  }

  prepareChartOptions(miningStats) {
    let ring = [0.20, 0.80]; // Desktop
    if (isMobile() && !this.widget) {
      ring = [0.15, 0.60];
    }
    const pieSize = ring.map((radius) => `${radius * 100}%`);

    const series = this.generateChartSeriesData(miningStats);

    this.chartOptions = {
      animation: false,
      color: PoolRankingComponent.SERIES_COLORS,
      tooltip: {
        trigger: 'item',
        textStyle: {
          align: 'left',
        }
      },
      series: [
        {
          zlevel: 0,
          minShowLabelAngle: 1.8,
          name: 'Mining pool',
          type: 'pie',
          radius: pieSize,
          data: series.pools,
          labelLine: {
            lineStyle: {
              width: 2,
            },
          },
          label: {
            fontSize: 14,
            formatter: (serie) => `${serie.name === 'Binance Pool' ? 'Binance\nPool' : serie.name}`,
          },
          itemStyle: {
            borderRadius: 1,
            borderWidth: 1,
            borderColor: 'var(--bg)',
          },
          emphasis: {
            itemStyle: {
              shadowBlur: 40,
              shadowColor: 'var(--bg)',
            },
            labelLine: {
              lineStyle: {
                width: 3,
              }
            }
          }
        },
        this.minerBandsSeries(series.bands, ring),
      ],
    };
  }

  /**
   * The miner bands, drawn over the slices they divide.
   *
   * A pie serie cannot do this: its slices are laid out one after another around the circle,
   * whereas these sit several deep in the same wedge, each with its own radii. So they are
   * drawn as sectors of their own, placed the way the pie places its slices — centred, sized
   * against the shorter side of the chart, and measured clockwise from twelve o'clock — and the
   * geometry is worked out at render time so it survives a resize.
   */
  private minerBandsSeries(bands: MinerBand[], ring: number[]): object {
    return {
      type: 'custom',
      name: 'DATUM miners',
      coordinateSystem: 'none',
      // above the slices, which the bands replace the fill of wherever they are drawn
      z: 3,
      silent: false,
      data: bands,
      renderItem: (params, api) => {
        const band = bands[params.dataIndex];
        if (!band) {
          return null;
        }

        const width = api.getWidth();
        const height = api.getHeight();
        const unit = Math.min(width, height) / 2;
        const innerRadius = ring[0] * unit;
        const depth = (ring[1] - ring[0]) * unit;

        return {
          type: 'sector',
          shape: {
            cx: width / 2,
            cy: height / 2,
            r0: innerRadius + band.innerRadius * depth,
            r: innerRadius + band.outerRadius * depth,
            // canvas angles run from three o'clock and increase clockwise on screen, which is
            // where the pie's own twelve o'clock start and clockwise layout land
            startAngle: -Math.PI / 2 + 2 * Math.PI * band.startAngle,
            endAngle: -Math.PI / 2 + 2 * Math.PI * band.endAngle,
            clockwise: true,
          },
          style: {
            fill: band.color,
            stroke: 'var(--bg)',
            lineWidth: 1,
          },
        };
      },
      tooltip: {
        show: true,
        backgroundColor: 'rgba(17, 19, 31, 1)',
        borderRadius: 4,
        shadowColor: 'rgba(0, 0, 0, 0.5)',
        textStyle: {
          color: 'var(--tooltip-grey)',
        },
        borderColor: '#000',
        formatter: (params) => {
          const band = bands[params.dataIndex];
          const i = band.blockCount.toString();
          return `<b style="color: white">${band.name}</b><br>` +
            `${band.poolName} · ${band.poolShare}%<br>` +
            $localize`${ i }:INTERPOLATION: blocks`;
        }
      },
    };
  }

  onChartInit(ec) {
    if (this.chartInstance !== undefined) {
      return;
    }

    this.chartInstance = ec;
    this.chartInstance.on('click', (e) => {
      if (e.data.data === 9999) { // "Other"
        return;
      }
      this.zone.run(() => {
        const url = new RelativeUrlPipe(this.stateService).transform(`/mining/pool/${e.data.data}`);
        this.router.navigate([url]);
      });
    });
  }

  /**
   * Default mining stats if something goes wrong
   */
  getEmptyMiningStat(): MiningStats {
    return {
      lastEstimatedHashrate: 0,
      lastEstimatedHashrate3d: 0,
      lastEstimatedHashrate1w: 0,
      blockCount: 0,
      totalEmptyBlock: 0,
      totalEmptyBlockRatio: '',
      pools: [],
      totalBlockCount: 0,
      miningUnits: {
        hashrateDivider: 1,
        hashrateUnit: '',
      },
    };
  }

  onSaveChart() {
    const now = new Date();
    this.chartOptions.backgroundColor = 'var(--active-bg)';
    this.chartInstance.setOption(this.chartOptions);
    download(this.chartInstance.getDataURL({
      pixelRatio: 2,
      excludeComponents: ['dataZoom'],
    }), `pools-ranking-${this.timespan}-${Math.round(now.getTime() / 1000)}.svg`);
    this.chartOptions.backgroundColor = 'none';
    this.chartInstance.setOption(this.chartOptions);
  }

  isEllipsisActive(e) {
    return (e.offsetWidth < e.scrollWidth);
  }
}

