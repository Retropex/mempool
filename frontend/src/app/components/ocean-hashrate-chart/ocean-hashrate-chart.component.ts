import { ChangeDetectionStrategy, Component, Input, NgZone, OnInit, HostBinding } from '@angular/core';
import { Observable } from 'rxjs';
import { map, shareReplay, tap } from 'rxjs/operators';
import { EChartsOption, PieSeriesOption } from '../../graphs/echarts';
import { OceanService, OceanTemplateStats, OceanHashrateData } from '../../services/ocean.service';
import { originalChartColors as chartColors } from '../../app.constants';
import { download } from '../../shared/graphs.utils';
import { isMobile } from '../../shared/common.utils';

@Component({
  selector: 'app-ocean-hashrate-chart',
  templateUrl: './ocean-hashrate-chart.component.html',
  styleUrls: ['./ocean-hashrate-chart.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false,
})
export class OceanHashrateChartComponent implements OnInit {
  @Input() height: number = 300;
  @Input() widget = false;

  isLoading = true;
  chartOptions: EChartsOption = {};
  chartInitOptions = {
    renderer: 'svg',
  };
  chartInstance: any = undefined;

  @HostBinding('attr.dir') dir = 'ltr';

  oceanHashrateObservable$: Observable<OceanHashrateData>;

  constructor(
    private oceanService: OceanService,
    private zone: NgZone,
  ) {}

  ngOnInit(): void {
    this.oceanHashrateObservable$ = this.oceanService.getHashrateDistribution()
      .pipe(
        tap(() => {
          this.isLoading = false;
          this.prepareChartOptions();
        }),
        shareReplay(1)
      );
  }

  generateOceanChartSerieData(oceanData: OceanHashrateData) {
    let shareThreshold = this.widget ? 5.0 : 3.0; // Higher threshold for widget to avoid clutter
    if (isMobile()) {
      shareThreshold = this.widget ? 10.0 : 5.0; // Even higher threshold on mobile
    }

    const pieData: any[] = [];
    const otherTemplates: OceanTemplateStats[] = [];
    
    oceanData.templates.forEach((template) => {
      if (template.percentage < shareThreshold) {
        otherTemplates.push(template);
      } else {
        pieData.push({
          name: template.template,
          value: template.shares,
          percentage: template.percentage,
          itemStyle: {
            color: this.getTemplateColor(template.template),
          },
          label: {
            color: this.getTemplateColor(template.template), // Use same color as slice
          }
        });
      }
    });

    // Group smaller templates under "Other"
    if (otherTemplates.length > 0) {
      const otherSharesSum = otherTemplates.reduce((acc, template) => acc + template.shares, 0);
      const otherPercentageSum = otherTemplates.reduce((acc, template) => acc + template.percentage, 0);
      
      pieData.push({
        name: `Other (${otherTemplates.length})`,
        value: otherSharesSum,
        percentage: otherPercentageSum,
        itemStyle: {
          color: '#666666',
        },
        label: {
          color: '#666666', // Use same color as slice
        }
      });
    }

    // Sort by percentage descending
    return pieData.sort((a, b) => b.percentage - a.percentage);
  }

  getTemplateColor(templateName: string): string {
    const colorMap: { [key: string]: string } = {
      'Ocean': '#0052cc',
      'Datum': '#00b4d8', 
      'Core': '#f77f00',
      'OrdiRespector': '#8338ec',
      'Data-Free': '#06ffa5',
      'Unknown 1': '#fb8500',
      'Unknown 2': '#219ebc',
      'Unknown 3': '#023047',
    };
    
    return colorMap[templateName] || chartColors[Object.keys(colorMap).length % chartColors.length];
  }

  prepareChartOptions() {
    this.oceanHashrateObservable$.subscribe((oceanData) => {
      const pieData = this.generateOceanChartSerieData(oceanData);
      
      // Responsive pie size logic similar to pool-ranking
      let pieSize = ['25%', '65%']; // Desktop default
      if (this.widget) {
        pieSize = isMobile() ? ['20%', '50%'] : ['15%', '60%']; // Widget responsive
      } else if (isMobile()) {
        pieSize = ['15%', '60%']; // Mobile non-widget
      }
      
      // Responsive edge distance logic similar to pool-ranking
      let edgeDistance: any = '20%';
      if (isMobile() && this.widget) {
        edgeDistance = 0;
      } else if (isMobile() && !this.widget || this.widget) {
        edgeDistance = 10;
      }
      
      this.chartOptions = {
        tooltip: {
          trigger: 'item',
          textStyle: {
            align: 'left',
          },
          backgroundColor: 'rgba(17, 19, 31, 1)',
          borderRadius: 4,
          shadowColor: 'rgba(0, 0, 0, 0.5)',
          shadowBlur: 10,
          formatter: (data: any) => {
            const percentage = data.data?.percentage || data.percentage || 0;
            const value = data.data?.value || data.value || 0;
            const name = data.data?.name || data.name || 'Unknown';
            return `<b style="color: white">${name}</b><br>
                    Shares: ${value.toLocaleString()}<br>
                    Percentage: ${percentage.toFixed(1)}%`;
          }
        },
        series: [
          {
            type: 'pie',
            radius: pieSize,
            center: ['50%', '50%'],
            data: pieData,
            label: {
              show: true, // Always show labels
              position: 'outside',
              minMargin: 5,
              edgeDistance: edgeDistance,
              lineHeight: 15,
              fontSize: 14,
              fontWeight: 'normal',
              formatter: (data: any) => {
                const percentage = data.data?.percentage || data.percentage || 0;
                const name = data.data?.name || data.name || 'Unknown';
                
                if (this.widget) {
                  // Shorter format for widget
                  return `${name}\n${percentage.toFixed(1)}%`;
                } else {
                  // Full format for full view
                  return `${name}: ${percentage.toFixed(1)}%`;
                }
              }
            },
           labelLine: {
              length2: 25,
              lineStyle: {
                width: 2,
              },
            },
            emphasis: {
              scale: true,
              scaleSize: 10,
              itemStyle: {
                shadowBlur: 10,
                shadowOffsetX: 0,
                shadowColor: 'rgba(0, 0, 0, 0.5)'
              },
              labelLine: {
                lineStyle: {
                  width: 3,
                }
              }
            },
            itemStyle: {
              borderWidth: 2,
              borderColor: '#1a1a1a'
            }
          } as PieSeriesOption
        ],
        legend: this.widget ? undefined : {
          orient: 'vertical',
          left: 'left',
          top: 'middle',
          textStyle: {
            color: '#b1b1b1'
          },
          formatter: (name: string) => {
            const item = pieData.find(d => d.name === name);
            const percentage = item?.percentage || 0;
            return `${name}: ${percentage.toFixed(1)}%`;
          }
        }
      };
    });
  }

  onChartInit(ec: any) {
    this.chartInstance = ec;
  }

  onChartClick(event: any) {
    if (event?.data?.name) {
      console.log('Template clicked:', event.data.name);
    }
  }

  onSaveChart() {
    this.zone.run(() => {
      const now = new Date();
      download(this.chartInstance.getDataURL({
        pixelRatio: 2,
        excludeComponents: ['toolbox'],
      }), `ocean-hashrate-distribution-${Math.round(now.getTime() / 1000)}.png`);
    });
  }

  getTotalShares(oceanData: OceanHashrateData): number {
    return this.oceanService.getTotalShares(oceanData);
  }

  getFormattedDate(timestamp: number): string {
    if (!timestamp) {
      return '-';
    }
    // Convert timestamp to date
    const date = new Date(timestamp * 1000); // Multiply by 1000 if timestamp is in seconds
    
    // Format as simple date
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  }
}
