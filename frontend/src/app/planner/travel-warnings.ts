import { Component, inject } from '@angular/core';
import { TripStore } from '../core/trip-store';
import { RoutesService } from '../core/routes';

// Bar above the calendar listing hops where there isn't enough time to travel
@Component({
  selector: 'app-travel-warnings',
  template: `
    @if (routesSvc.warnings().length) {
      <div class="warn">
        @for (w of routesSvc.warnings(); track w.fromId + w.toId) {
          <button class="item" (click)="store.selectedStopId.set(w.toId)">⚠️ Day {{ w.day }}: {{ w.message }}</button>
        }
      </div>
    }`,
  styles: [`.warn{background:#fff4e5;border-bottom:1px solid #f3cf99;padding:4px 8px;display:flex;flex-direction:column;gap:2px}
            .item{all:unset;cursor:pointer;font-size:12px;color:#8a5a00}.item:hover{text-decoration:underline}`],
})
export class TravelWarnings {
  store = inject(TripStore);
  routesSvc = inject(RoutesService);
}