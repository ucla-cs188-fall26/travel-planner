import { Component, computed, effect, inject, viewChild } from '@angular/core';
import { GoogleMap, MapAdvancedMarker, MapPolyline } from '@angular/google-maps';
import { MatChipsModule } from '@angular/material/chips';
import { TripStore } from '../core/trip-store';
import { MapsLoader } from '../core/maps-loader';
import { environment } from '../../environments/environment';
import { Stop } from '../core/models';

// One color per trip day for markers and route lines
const DAY_COLORS = ['#3d5a80', '#e07a5f', '#81b29a', '#6d597a', '#f2a541', '#118ab2', '#ef476f'];

// Bottom-right pane: numbered markers per day, route lines, day filter, synced selection
@Component({
  selector: 'app-map-panel',
  imports: [GoogleMap, MapAdvancedMarker, MapPolyline, MatChipsModule],
  template: `
    <mat-chip-listbox class="days" [value]="store.dayFilter()"
                      (change)="store.dayFilter.set($event.value ?? null)">
      <mat-chip-option [value]="null">All</mat-chip-option>
      @for (d of store.days(); track d) { <mat-chip-option [value]="d">Day {{ d }}</mat-chip-option> }
    </mat-chip-listbox>
    @if (maps.ready()) {
      <google-map width="100%" height="100%" [options]="mapOptions">
        @for (m of markers(); track m.stop.id) {    <!-- One numbered pin per stop -->
          <map-advanced-marker [position]="m.pos" [title]="m.stop.title" [content]="m.el"
                               (mapClick)="store.selectedStopId.set(m.stop.id)" />
        }
        @for (r of routes(); track r.day) { <!-- One line per day, in time order -->
          <map-polyline [path]="r.path" [options]="{ strokeColor: r.color, strokeOpacity: 0.8, strokeWeight: 3 }" />
        }
      </google-map>
    } @else {
      <div class="loading">Loading map…</div>
    }`,
  styles: [`:host{display:flex;flex-direction:column;height:100%}
            .days{padding:4px 6px}
            google-map{flex:1;min-height:0;display:block}
            .loading{padding:24px;color:#888}`],
})
export class MapPanel {
  store = inject(TripStore);
  maps = inject(MapsLoader);
  private gmap = viewChild(GoogleMap);

  // Base map settings
  mapOptions: google.maps.MapOptions = {
    mapId: environment.googleMapId,
    disableDefaultUI: true,
    zoomControl: true,
  };

  // Visible stops with real coordinates
  private located = computed(() =>
    this.store.visibleStops().filter(s => s.place.lat != null && s.place.lng != null));

  // Markers numbered within each day, in time order
  markers = computed(() => {
    const sel = this.store.selectedStopId();
    const countByDay = new Map<number, number>();
    return [...this.located()]
      .sort((a, b) => a.start.localeCompare(b.start))
      .map(stop => {
        const n = (countByDay.get(stop.day) ?? 0) + 1;
        countByDay.set(stop.day, n);
        return { stop, pos: { lat: stop.place.lat!, lng: stop.place.lng! }, el: this.pin(stop, n, stop.id === sel) };
      });
  });

  // Straight lines connecting each day's stops in order
  routes = computed(() => {
    const byDay = new Map<number, Stop[]>();
    for (const s of this.located()) byDay.set(s.day, [...(byDay.get(s.day) ?? []), s]);
    return [...byDay.entries()].map(([day, stops]) => ({
      day,
      color: DAY_COLORS[(day - 1) % DAY_COLORS.length],
      path: [...stops].sort((a, b) => a.start.localeCompare(b.start)).map(s => ({ lat: s.place.lat!, lng: s.place.lng! })),
    }));
  });

  constructor() {
    this.maps.load(); 

    // Zoom to fit all visible stops whenever they or the day filter change
    effect(() => {
      const pts = this.located();
      const map = this.gmap()?.googleMap;
      if (!map || pts.length === 0) return;
      const bounds = new google.maps.LatLngBounds();
      pts.forEach(s => bounds.extend({ lat: s.place.lat!, lng: s.place.lng! }));
      map.fitBounds(bounds, 40);
    });

    // Pan to a stop selected on the calendar
    effect(() => {
      const s = this.store.selectedStop();
      const map = this.gmap()?.googleMap;
      if (map && s?.place.lat != null && s.place.lng != null) map.panTo({ lat: s.place.lat, lng: s.place.lng });
    });
  }

  // Builds a round numbered pin; the selected one is bigger with a black border
  private pin(stop: Stop, n: number, selected: boolean): HTMLElement {
    const el = document.createElement('div');
    const size = selected ? 30 : 24;
    el.textContent = String(n);
    el.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:${DAY_COLORS[(stop.day - 1) % DAY_COLORS.length]};
      color:#fff;display:flex;align-items:center;justify-content:center;font:600 12px system-ui;
      border:2px solid ${selected ? '#000' : '#fff'};box-shadow:0 1px 3px rgba(0,0,0,.4)`;
    return el;
  }
}