import { ChangeDetectionStrategy, Component, Input, NgZone, OnInit, HostBinding } from '@angular/core';
import { Observable } from 'rxjs';
import { map, shareReplay, tap } from 'rxjs/operators';
import { EChartsOption, PieSeriesOption } from '../../graphs/echarts';
import { BitnodesService, KnotsNodeStats, KnotsNodeResponse } from '../../services/bitnodes.service';
import { originalChartColors as chartColors } from '../../app.constants';
import { download } from '../../shared/graphs.utils';
import { isMobile } from '../../shared/common.utils';

@Component({
  selector: 'app-knots-nodes-chart',
  templateUrl: './knots-nodes-chart.component.html',
  styleUrls: ['./knots-nodes-chart.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false,
})
export class KnotsNodesChartComponent implements OnInit {
  @Input() height: number = 300;
  @Input() widget = false;

  isLoading = true;
  chartOptions: EChartsOption = {};
  chartInitOptions = {
    renderer: 'svg',
  };
  chartInstance: any = undefined;

  @HostBinding('attr.dir') dir = 'ltr';

  knotsNodesObservable$: Observable<KnotsNodeResponse>;

  constructor(
    private bitnodesService: BitnodesService,
    private zone: NgZone,
  ) {}

  ngOnInit(): void {
    this.knotsNodesObservable$ = this.bitnodesService.getKnotsNodeDistribution()
      .pipe(
        tap(() => {
          this.isLoading = false;
          this.prepareChartOptions();
        }),
        shareReplay(1)
      );
  }

  generateKnotsChartSerieData(knotsStats: KnotsNodeStats[], edgeDistance: any) {
    let shareThreshold = 1.0;
    if (isMobile()) {
      shareThreshold = 2.0;
    } else if (this.widget) {
      shareThreshold = 1.5;
    }

    const data: object[] = [];
    let totalShareOther = 0;
    let totalCountOther = 0;

    // Generate colors for countries
    const countryColors = this.generateCountryColors(knotsStats);

    knotsStats.forEach((country, index) => {
      if (country.percentage < shareThreshold) {
        totalShareOther += country.percentage;
        totalCountOther += country.count;
        return;
      }
      
      data.push({
        itemStyle: {
          color: countryColors[index % countryColors.length],
        },
        value: country.percentage,
        name: country.country + ((isMobile() || this.widget) ? `` : ` (${country.percentage.toFixed(1)}%)`),
        label: {
          overflow: 'none',
          color: 'var(--tooltip-grey)',
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
            const count = country.count.toString();
            const percentage = country.percentage.toFixed(1);
            return `<b style="color: white">${country.country} (${percentage}%)</b><br>` +
              $localize`${count}:INTERPOLATION: nodes`;
          }
        },
        data: country.country,
      } as any);
    });

    const percentage = totalShareOther.toFixed(1) + '%';

    // 'Other' countries
    if (totalShareOther > 0) {
      data.push({
        itemStyle: {
          color: '#6b6b6b',
        },
        value: totalShareOther,
        name: $localize`Other (${percentage})`,
        label: {
          overflow: 'none',
          color: 'var(--tooltip-grey)',
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
            const count = totalCountOther.toString();
            return `<b style="color: white">` + $localize`Other (${percentage})` + `</b><br>` + 
              $localize`${count}:INTERPOLATION: nodes`;
          }
        },
        data: 'Other' as any,
      } as any);
    }

    return data;
  }

  generateCountryColors(knotsStats: KnotsNodeStats[]): string[] {
    // Use similar colors to the pool ranking but generate enough for countries
    const baseColors = [
      '#D81B60', '#8E24AA', '#5E35B1', '#3949AB',
      '#1E88E5', '#039BE5', '#00ACC1', '#00897B',
      '#43A047', '#7CB342', '#C0CA33', '#FDD835',
      '#FFB300', '#FB8C00', '#F57C00', '#FF5722',
      '#795548', '#607D8B', '#9E9E9E'
    ];
    
    // Extend colors if we have more countries than colors
    const colors = [...baseColors];
    while (colors.length < knotsStats.length) {
      colors.push(...baseColors);
    }
    
    return colors;
  }

  prepareChartOptions() {
    this.knotsNodesObservable$.subscribe(knotsData => {
      // Construction des stats Tor/Clearnet
      const total = knotsData.totals.totalNodes;
      const clearnet = knotsData.totals.clearnetNodes;
      const tor = knotsData.totals.torNodes;
      const pieData = [
        {
          value: clearnet,
          name: 'Clearnet',
          itemStyle: { color: '#1E88E5' },
          label: { color: '#1E88E5' },
          tooltip: {
            formatter: () => `<b style=\"color: white\">Clearnet</b><br>${clearnet} nodes (${((clearnet/total)*100).toFixed(1)}%)`
          }
        },
        {
          value: tor,
          name: 'Tor',
          itemStyle: { color: '#8E24AA' },
          label: { color: '#8E24AA' },
          tooltip: {
            formatter: () => `<b style=\"color: white\">Tor</b><br>${tor} nodes (${((tor/total)*100).toFixed(1)}%)`
          }
        }
      ];

      // Responsive pie size logic
      let pieSize = ['20%', '80%'];
      if (this.widget) {
        pieSize = isMobile() ? ['20%', '50%'] : ['15%', '60%'];
      } else if (isMobile()) {
        pieSize = ['15%', '60%'];
      }

      this.chartOptions = {
        animation: true,
        color: ['#1E88E5', '#8E24AA'],
        tooltip: {
          trigger: 'item',
          textStyle: {
            align: 'left',
          },
          backgroundColor: 'rgba(17, 19, 31, 1)',
        },
        series: [
          {
            zlevel: 0,
            minShowLabelAngle: 1.8,
            name: 'Knots nodes',
            type: 'pie',
            radius: pieSize,
            data: pieData,
            labelLine: {
              length2: 25,
              lineStyle: {
                width: 2,
              },
            },
            label: {
              fontSize: 14,
              formatter: (serie) => `${serie.name}`,
            },
            itemStyle: {
              borderRadius: 1,
              borderWidth: 1,
              borderColor: '#000',
            },
            emphasis: {
              scale: true,
              scaleSize: 10,
              itemStyle: {
                shadowBlur: 40,
                shadowColor: 'rgba(0, 0, 0, 0.75)',
              },
              labelLine: {
                lineStyle: {
                  width: 3,
                }
              }
            }
          }
        ],
      };
    });
  }

  onChartInit(ec) {
    if (this.chartInstance !== undefined) {
      return;
    }
    this.chartInstance = ec;
  }

  onSaveChart() {
    const now = new Date();
    this.chartOptions.backgroundColor = 'var(--active-bg)';
    this.chartInstance.setOption(this.chartOptions);
    download(this.chartInstance.getDataURL({
      pixelRatio: 2,
      excludeComponents: ['dataZoom'],
    }), `knots-nodes-distribution-${Math.round(now.getTime() / 1000)}.svg`);
    this.chartOptions.backgroundColor = 'none';
    this.chartInstance.setOption(this.chartOptions);
  }

  isEllipsisActive(e) {
    return (e.offsetWidth < e.scrollWidth);
  }

  getTotalKnotsNodes(knotsData: KnotsNodeResponse): number {
    return knotsData.totals.totalNodes;
  }

  getClearnetNodes(knotsData: KnotsNodeResponse): number {
    return knotsData.totals.clearnetNodes;
  }

  getTorNodes(knotsData: KnotsNodeResponse): number {
    return knotsData.totals.torNodes;
  }

  getTotalBitcoinNodes(knotsData: KnotsNodeResponse): number {
    return knotsData.totals.totalBitcoinNodes;
  }

  getKnotsPercentageOfTotal(knotsData: KnotsNodeResponse): number {
    return knotsData.totals.percentageOfTotal;
  }
}
