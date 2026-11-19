import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { environment } from '../../environments/environment';
import { TripStore } from './trip-store';
import { Stop } from './models';

export type TravelMode = 'WALK' | 'DRIVE' | 'BICYCLE'; // Modes that allow stops in between

export interface Leg { fromId: string; toId: string; seconds: number; meters: number; } // One hop between two stops
export interface DayRoute { day: number; path: google.maps.LatLngLiteral[]; legs: Leg[]; seconds: number; meters: number; }
export interface TravelWarning { day: number; fromId: string; toId: string; message: string; } // Insufficient time warning

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const FIELD_MASK = 'routes.polyline.encodedPolyline,routes.duration,routes.distanceMeters,routes.legs.duration,routes.legs.distanceMeters'; // Only billed for these fields
const secs = (d?: string) => (d ? parseInt(d, 10) : 0);

// Google's encoded polyline
export function decodePolyline(encoded: string): google.maps.LatLngLiteral[] {
  const points: google.maps.LatLngLiteral[] = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let shift = 0, result = 0, b: number;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

// Computes one street route per day whenever the stops or travel mode change
@Injectable({ providedIn: 'root' })
export class RoutesService {
  private store = inject(TripStore);
  private cache = new Map<string, DayRoute | null>(); 
  private run = 0;

  readonly routes = signal<Map<number, DayRoute>>(new Map()); //route per day
  readonly loading = signal(false);

  // Travel mode is saved per trip (default walking)
  readonly mode = computed<TravelMode>(() => (this.store.activeTrip()?.details['travelMode'] as TravelMode) ?? 'WALK');

  // Flags hops where the gap between two stops is shorter than the travel time
  readonly warnings = computed<TravelWarning[]>(() => {
    const byId = new Map(this.store.stops().map(s => [s.id, s]));
    const out: TravelWarning[] = [];
    for (const r of this.routes().values()) {
      for (const leg of r.legs) {
        const a = byId.get(leg.fromId), b = byId.get(leg.toId);
        if (!a || !b) continue;
        const gapMin = (Date.parse(b.start) - Date.parse(a.end)) / 60000;
        const needMin = Math.ceil(leg.seconds / 60);
        if (gapMin < needMin) {
          out.push({ day: r.day, fromId: a.id, toId: b.id,
            message: `${a.title} → ${b.title}: ${needMin} min to get there, but only ${Math.max(0, Math.round(gapMin))} min between them` });
        }
      }
    }
    return out;
  });

  constructor() {
    // Recompute when the itinerary or mode changes
    effect(() => {
      const stops = this.store.stops();
      const mode = this.mode();
      untracked(() => this.refresh(stops, mode));
    });
  }

  // The hop that arrives at a stop
  legInto(stopId: string): Leg | null {
    for (const r of this.routes().values()) {
      const leg = r.legs.find(l => l.toId === stopId);
      if (leg) return leg;
    }
    return null;
  }

  private async refresh(stops: Stop[], mode: TravelMode) {
    const run = ++this.run;
    const byDay = new Map<number, Stop[]>();
    for (const s of stops) {
      if (s.place.lat != null && s.place.lng != null) byDay.set(s.day, [...(byDay.get(s.day) ?? []), s]);
    }
    if (byDay.size === 0) { this.routes.set(new Map()); this.loading.set(false); return; }

    await new Promise(r => setTimeout(r, 400));
    if (run !== this.run) return;

    this.loading.set(true);
    const entries = await Promise.all(
      [...byDay.entries()].map(async ([day, list]) => [day, await this.dayRoute(day, list, mode)] as const));
    if (run !== this.run) return;

    this.routes.set(new Map(entries.filter((e): e is readonly [number, DayRoute] => !!e[1])));
    this.loading.set(false);
  }

  // One Routes API call per day
  private async dayRoute(day: number, stops: Stop[], mode: TravelMode): Promise<DayRoute | null> {
    const pts = [...stops].sort((a, b) => a.start.localeCompare(b.start));
    if (pts.length < 2 || pts.length > 27) return null;                     // API allows at most 25 stops in between

    const key = mode + '|' + pts.map(s => `${s.id}@${s.place.lat},${s.place.lng}`).join(';');
    if (this.cache.has(key)) {
      const hit = this.cache.get(key);
      return hit ? { ...hit, day } : null;
    }

    const ll = (s: Stop) => ({ location: { latLng: { latitude: s.place.lat!, longitude: s.place.lng! } } });
    try {
      const res = await fetch(ROUTES_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': environment.googleMapsApiKey,
          'X-Goog-FieldMask': FIELD_MASK,
        },
        body: JSON.stringify({
          origin: ll(pts[0]),
          destination: ll(pts[pts.length - 1]),
          intermediates: pts.slice(1, -1).map(ll),
          travelMode: mode,
        }),
      });
      if (!res.ok) throw new Error(`Routes API ${res.status}: ${await res.text()}`);

      const route = (await res.json()).routes?.[0];
      if (!route?.polyline?.encodedPolyline) { this.cache.set(key, null); return null; } // No route exists 

      const legs: Leg[] = (route.legs ?? []).map((l: { duration?: string; distanceMeters?: number }, i: number) => ({
        fromId: pts[i].id, toId: pts[i + 1].id, seconds: secs(l.duration), meters: l.distanceMeters ?? 0,
      }));
      const result: DayRoute = {
        day, legs,
        path: decodePolyline(route.polyline.encodedPolyline),
        seconds: secs(route.duration),
        meters: route.distanceMeters ?? 0,
      };
      this.cache.set(key, result);
      return result;
    } catch (e) {
      console.warn('[routes] day', day, e); 
      return null;
    }
  }
}