import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { StateService } from '@app/services/state.service';
import { Bip110DeploymentInfo } from '@interfaces/node-api.interface';

@Component({
  selector: 'app-bip110-deployment',
  templateUrl: './bip110-deployment.component.html',
  styleUrls: ['./bip110-deployment.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false,
})
export class Bip110DeploymentComponent implements OnInit {
  deployment$: Observable<Bip110DeploymentInfo>;
  isLoading$: Observable<boolean>;
  bip110ScanProgress$: Observable<number>;

  constructor(
    private stateService: StateService,
  ) {}

  ngOnInit(): void {
    this.deployment$ = this.stateService.bip110Deployment$;
    this.isLoading$ = this.stateService.isLoadingWebSocket$;
    this.bip110ScanProgress$ = this.stateService.loadingIndicators$.pipe(
      map(indicators => indicators['bip110-scan'] !== undefined ? indicators['bip110-scan'] : -1)
    );
  }
}
