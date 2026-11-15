import { Injectable, inject } from '@angular/core';
import { Subject, EMPTY, from, buffer, debounceTime, filter, switchMap, catchError, share, tap } from 'rxjs';
import { Api } from './api';
import { TripStore } from './trip-store';
import { MapsLoader } from './maps-loader';
import { EditDiff, ChangeResponse } from './models';

// Batches calendar edits, asks the LLM for a change, and shows it as a preview
@Injectable({ providedIn: 'root' })
export class ChangeLoop {
  private api = inject(Api);
  private store = inject(TripStore);
  private maps = inject(MapsLoader);
  private edits$ = new Subject<EditDiff>(); // drag/resize actions exist here

  constructor() {
    const edits = this.edits$.pipe(share());
    edits.pipe(
      buffer(edits.pipe(debounceTime(900))),
      filter(diff => diff.length > 0),
      tap(() => this.store.changeStatus.set('pending')),
      switchMap(diff => { // A newer batch cancels an in-flight request
        const trip = this.store.activeTrip();
        if (!trip) return EMPTY;
        return this.api.change({ diff, trip, groupPreferences: this.store.groupPrefs() }).pipe(
          switchMap(res => from(this.showPreview(trip.id, res))),
          catchError(err => { // Backend failed case, so keep the user's edit and show an error note
            console.error('[change]', err);
            this.store.changeStatus.set('error'); // Snapshot stays so "Undo change" can restore it
            return EMPTY;
          }),
        );
      }),
    ).subscribe();
  }

  // Called by the calendar after each drag/resize
  push(diff: EditDiff) { this.edits$.next(diff); }

  // Merges the LLM's changes into the itinerary, protects anchors, resolves places, shows the preview
  private async showPreview(tripId: string, res: ChangeResponse) {
    const trip = this.store.activeTrip();
    if (!trip || trip.id !== tripId) return; // User switched trips meanwhile
    if (!res.changes.length) {  // Nothing to suggest so keep the edit
      this.store.clearEditSnapshot();
      this.store.changeStatus.set('idle');
      return;
    }

    // locked anchors never move without asking
    const locked = new Map(trip.stops.filter(s => s.locked).map(s => [s.id, s]));
    const warnings = [...res.warnings];
    const changes = res.changes.map(c => {
      const orig = locked.get(c.id);
      if (orig && (orig.start !== c.start || orig.end !== c.end)) {
        warnings.push(`Kept "${orig.title}" in place (it's a locked must-do).`);
        return orig;
      }
      return c;
    });

    // Apply changes over the current stops, then fix coordinates for any new places
    const byId = new Map(trip.stops.map(s => [s.id, s]));
    changes.forEach(c => byId.set(c.id, c));
    const stops = await this.maps.resolveStops([...byId.values()], String(trip.details['destination'] ?? ''));

    this.store.showPreview(res.summary, stops, warnings);
    this.store.changeStatus.set('idle');
  }
}