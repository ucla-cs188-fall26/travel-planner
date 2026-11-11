import { Injectable, signal } from '@angular/core';
import { setOptions, importLibrary } from '@googlemaps/js-api-loader';
import { environment } from '../../environments/environment';
import { Place, Stop } from './models';

// Loads Google Maps once and resolves real coordinates for stops via Places
@Injectable({ providedIn: 'root' })
export class MapsLoader {
  readonly ready = signal(false); 
  private loading?: Promise<void>;
  private cache = new Map<string, Place>(); 

  // Loads the maps, marker and places libraries
  load(): Promise<void> {
    if (!this.loading) {
      setOptions({ key: environment.googleMapsApiKey, v: 'weekly' });
      this.loading = Promise.all([importLibrary('maps'), importLibrary('marker'), importLibrary('places')])
        .then(() => this.ready.set(true));
    }
    return this.loading;
  }

  // Looks up one place by name near the destination
  async resolvePlace(name: string, near: string): Promise<Place | null> {
    const key = `${name}|${near}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    await this.load();
    const { Place } = (await importLibrary('places')) as google.maps.PlacesLibrary;
    const { places } = await Place.searchByText({
      textQuery: near ? `${name}, ${near}` : name,
      fields: ['id', 'displayName', 'location', 'formattedAddress'],
      maxResultCount: 1,
    });
    const p = places[0];
    if (!p?.location) return null;
    const place: Place = {
      name: p.displayName ?? name,
      placeId: p.id,
      lat: p.location.lat(),
      lng: p.location.lng(),
      address: p.formattedAddress ?? undefined,
    };
    this.cache.set(key, place);
    return place;
  }

  // Fills in coordinates for every stop that doesn't already have a Google placeId
  async resolveStops(stops: Stop[], destination: string): Promise<Stop[]> {
    return Promise.all(stops.map(async s => {
      if (s.place.placeId && s.place.lat != null) return s;
      try {
        const place = await this.resolvePlace(s.place.name, destination);
        return place ? { ...s, place } : s;
      } catch (e) {
        console.warn('[maps] lookup failed for', s.place.name, e);  //caution to not break itinerary for a bad lookup
        return s;
      }
    }));
  }
}