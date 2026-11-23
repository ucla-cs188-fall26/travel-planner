import { Component, computed, effect, inject, viewChild } from '@angular/core';
import { GoogleMap, MapAdvancedMarker, MapPolyline } from '@angular/google-maps';
import { MatChipsModule } from '@angular/material/chips';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { TripStore } from '../core/trip-store';
import { TripRepo } from '../core/trip-repo';
import { MapsLoader } from '../core/maps-loader';
import { RoutesService, TravelMode } from '../core/routes';
import { environment } from '../../environments/environment';
import { Stop } from '../core/models';

const DAY_COLORS = ['#3d5a80', '#e07a5f', '#81b29a', '#6d597a', '#f2a541', '#118ab2', '#ef476f'];   // One color per day

const fmtTime = (sec: number) => sec < 3600 ? `${Math.round(sec / 60)} min` : `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`;
const fmtDist = (m: number) => `${(m / 1000).toFixed(1)} km`;
const MODE_WORD: Record<TravelMode, string> = { WALK: 'walking', DRIVE: 'driving', BICYCLE: 'cycling' };

// Bottom-right pane: numbered markers, street routes per day, day filter, travel mode, synced selection
@Component({
  selector: 'app-map-panel',
  imports: [GoogleMap, MapAdvancedMarker, MapPolyline, MatChipsModule, MatButtonToggleModule],
  template: `
    <div class="bar">
      <mat-chip-listbox [value]="store.dayFilter()" (change)="store.dayFilter.set($event.value ?? null)">   <!-- Day filter -->
        <mat-chip-option [value]="null">All</mat-chip-option>
        @for (d of store.days(); track d) { <mat-chip-option [value]="d">Day {{ d }}</mat-chip-option> }
      </mat-chip-listbox>
      <mat-button-toggle-group [value]="routesSvc.mode()" (change)="setMode($event.value)" hideSingleSelectionIndicator>  <!-- Travel mode -->
        <mat-button-toggle value="WALK">Walk</mat-button-toggle>
        <mat-button-toggle value="DRIVE">Drive</mat-button-toggle>
        <mat-button-toggle value="BICYCLE">Bike</mat-button-toggle>
      </mat-button-toggle-group>
    </div>

    @if (summaries().length) { <!-- Daily totals from the Routes API -->
      <div class="summary">
        @for (s of summaries(); track s.day) {
          <span><b [style.color]="s.color">Day {{ s.day }}</b> {{ s.text }}</span>
        }
        @if (routesSvc.loading()) { <span class="quiet">Updating routes…</span> }
      </div>
    }

    @if (maps.ready()) {
      <google-map width="100%" height="100%" [options]="mapOptions">
        @for (m of markers(); track m.stop.id) { <!-- Numbered pin per stop -->
          <map-advanced-marker [position]="m.pos" [title]="m.stop.title" [content]="m.el"
                               (mapClick)="store.selectedStopId.set(m.stop.id)" />
        }
        @for (r of lines(); track r.day) {  <!-- Street route, or dashed straight line as fallback -->
          <map-polyline [path]="r.path" [options]="r.options" />
        }
      </google-map>
    } @else {
      <div class="loading">Loading map…</div>
    }`,
  styles: [`:host{display:flex;flex-direction:column;height:100%}
            .bar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 6px;flex-wrap:wrap}
            .summary{display:flex;gap:12px;flex-wrap:wrap;padding:0 8px 4px;font-size:12px;color:#444}
            .quiet{color:#888}
            google-map{flex:1;min-height:0;display:block}
            .loading{padding:24px;color:#888}`],
})
export class MapPanel {
  store = inject(TripStore);
  maps = inject(MapsLoader);
  routesSvc = inject(RoutesService);
  private repo = inject(TripRepo);
  private gmap = viewChild(GoogleMap);

  mapOptions: google.maps.MapOptions = { mapId: environment.googleMapId, disableDefaultUI: true, zoomControl: true };

  // Visible stops that have real coordinates
  private located = computed(() => this.store.visibleStops().filter(s => s.place.lat != null && s.place.lng != null));

  // Markers numbered 1, 2, 3… within each day, in time order
  markers = computed(() => {
    const sel = this.store.selectedStopId();
    const count = new Map<number, number>();
    return [...this.located()].sort((a, b) => a.start.localeCompare(b.start)).map(stop => {
      const n = (count.get(stop.day) ?? 0) + 1;
      count.set(stop.day, n);
      return { stop, pos: { lat: stop.place.lat!, lng: stop.place.lng! }, el: this.pin(stop, n, stop.id === sel) };
    });
  });

  // One line per visible day: the street route if computed, otherwise a dashed straight line
  lines = computed(() => {
    const real = this.routesSvc.routes();
    const byDay = new Map<number, Stop[]>();
    for (const s of this.located()) byDay.set(s.day, [...(byDay.get(s.day) ?? []), s]);
    return [...byDay.entries()].map(([day, stops]) => {
      const color = DAY_COLORS[(day - 1) % DAY_COLORS.length];
      const route = real.get(day);
      const path = route
        ? route.path
        : [...stops].sort((a, b) => a.start.localeCompare(b.start)).map(s => ({ lat: s.place.lat!, lng: s.place.lng! }));
      const options: google.maps.PolylineOptions = route
        ? { strokeColor: color, strokeOpacity: 0.85, strokeWeight: 4 }
        : { strokeColor: color, strokeOpacity: 0,  // Dashed = not a real route yet
            icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.8, scale: 3 }, offset: '0', repeat: '12px' }] };
      return { day, path, options };
    });
  });

  // per day summary
  summaries = computed(() => {
    const filter = this.store.dayFilter();
    const word = MODE_WORD[this.routesSvc.mode()];
    return [...this.routesSvc.routes().values()]
      .filter(r => filter == null || r.day === filter)
      .sort((a, b) => a.day - b.day)
      .map(r => ({ day: r.day, color: DAY_COLORS[(r.day - 1) % DAY_COLORS.length], text: `${fmtDist(r.meters)} · ${fmtTime(r.seconds)} ${word}` }));
  });

  constructor() {
    this.maps.load();

    // Fit the map to the visible stops
    effect(() => {
      const pts = this.located();
      const map = this.gmap()?.googleMap;
      if (!map || pts.length === 0) return;
      const bounds = new google.maps.LatLngBounds();
      pts.forEach(s => bounds.extend({ lat: s.place.lat!, lng: s.place.lng! }));
      map.fitBounds(bounds, 40);
    });

    // Pan to the stop selected on the calendar
    effect(() => {
      const s = this.store.selectedStop();
      const map = this.gmap()?.googleMap;
      if (map && s?.place.lat != null && s.place.lng != null) map.panTo({ lat: s.place.lat, lng: s.place.lng });
    });
  }

  // Save the travel mode on the trip so the whole group sees the same routes
  async setMode(mode: TravelMode) {
    const t = this.store.activeTrip();
    if (!t || mode === this.routesSvc.mode()) return;
    const details = { ...t.details, travelMode: mode };
    this.store.patchActiveTrip({ details });
    await this.repo.updateTrip(t.id, { details });
  }

  // Round numbered pin; bigger with a black border when selected
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