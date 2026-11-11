import { Component, OnInit, inject } from '@angular/core';
import { JsonPipe } from '@angular/common';
import { SplitComponent, SplitAreaComponent } from 'angular-split';
import { TripList } from './trip-list';
import { TripStore } from '../core/trip-store';
import { Api } from '../core/api';
import { environment } from '../../environments/environment';
import { CalendarPanel } from './calendar-panel';
import { MapPanel } from './map-panel';
import { MapsLoader } from '../core/maps-loader';

// Three-pane planner: trip list | chat | calendar over map
@Component({
  selector: 'app-planner-page',
  imports: [SplitComponent, SplitAreaComponent, TripList, CalendarPanel, MapPanel],
  template: `
    <as-split direction="horizontal" unit="percent" gutterSize="6">
      <as-split-area [size]="20" [minSize]="14"><app-trip-list /></as-split-area>
      <as-split-area [size]="55" [minSize]="30">
        <div class="placeholder">Chat</div>
      </as-split-area>
      <as-split-area [size]="25" [minSize]="20"> 
        <as-split direction="vertical" unit="percent" gutterSize="6">
          <as-split-area [size]="50"><app-calendar-panel /></as-split-area>
          <as-split-area [size]="50"><app-map-panel /></as-split-area>
        </as-split>
      </as-split-area>
    </as-split>`,
  styles: [`:host{display:block;height:100%}
            as-split-area{display:flex;flex-direction:column;overflow:hidden}
            .placeholder{padding:16px;color:#888}`],
})
export class PlannerPage implements OnInit {
  store = inject(TripStore);
  private api = inject(Api);
  private maps = inject(MapsLoader);

  // On load: fetch the mock trip into the store and then look up coordinates for these stops
  async ngOnInit() {
    if (environment.useMock && this.store.trips().length === 0) {
      const trip = await this.api.getMockTrip();
      this.store.setTrips([trip]);
      this.store.selectTrip(trip.id);
      const stops = await this.maps.resolveStops(trip.stops, String(trip.details['destination'] ?? ''));
      this.store.setStops(stops, false);
    }
  }
}