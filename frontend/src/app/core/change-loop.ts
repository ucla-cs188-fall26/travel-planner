import { Injectable, inject } from '@angular/core';
import { Subject, EMPTY, buffer, debounceTime, filter, switchMap, catchError, share, tap } from 'rxjs';
import { Api } from './api';
import { TripStore } from './trip-store';
import { MapsLoader } from './maps-loader';
import { EditDiff, ChangeResponse } from './models';

// Batch calendar edits, ask the backend to re-solve the constraints, and preview the result.
@Injectable({ providedIn: 'root' })
export class ChangeLoop {
  private api = inject(Api);
  private store = inject(TripStore);
  private maps = inject(MapsLoader);
  private edits$ = new Subject<{ tripId: string; diff: EditDiff }>();

  constructor() {
    const edits = this.edits$.pipe(share());
    edits.pipe(
      buffer(edits.pipe(debounceTime(900))),
      filter(diff => diff.length > 0),
      switchMap(batch => { // A newer batch cancels an in-flight request
        const trip = this.store.activeTrip();
        if (!trip) return EMPTY;
        const diff = batch.filter(edit => edit.tripId === trip.id).map(edit => edit.diff);
        if (!diff.length) return EMPTY;
        // A stop may be moved several times in one batch: keep the first origin and last destination.
        const merged = new Map<string, EditDiff>();
        diff.forEach(edit => merged.set(edit.stopId, { ...edit, from: merged.get(edit.stopId)?.from ?? edit.from }));
        return this.api.change({ diff: [...merged.values()], trip, groupPreferences: this.store.groupPrefs() }).pipe(
          tap(res => this.showPreview(trip.id, res)),
          catchError(err => { // Backend failed case, so keep the user's edit and show an error note
            console.error('[change]', err);
            if (this.store.activeTripId() === trip.id) {
              this.store.changeError.set(err?.message ?? 'Could not check this change.');
              this.store.changeStatus.set('error'); // Snapshot stays so "Undo change" can restore it
            }
            return EMPTY;
          }),
        );
      }),
    ).subscribe();
  }

  // Called by the calendar after each drag/resize
  push(diff: EditDiff) {
    const tripId = this.store.activeTripId();
    if (!tripId) return;
    this.store.changeStatus.set('pending');
    this.store.changeError.set(null);
    this.edits$.next({ tripId, diff });
  }

  // Render the solver preview immediately; coordinate enrichment runs separately.
  private showPreview(tripId: string, res: ChangeResponse) {
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
    changes.forEach(c => {
      const existing = byId.get(c.id);
      byId.set(c.id, existing?.title === c.title ? { ...c, place: existing.place } : c);
    });
    const stops = [...byId.values()];
    this.store.showPreview(res.summary, stops, warnings);
    this.store.changeStatus.set('idle');
    const preview = this.store.preview();
    void this.maps.resolveStops(stops, String(trip.details['destination'] ?? '')).then(resolved => {
      if (this.store.activeTripId() !== tripId || this.store.preview() !== preview) return;
      this.store.showPreview(res.summary, resolved, warnings);
    }).catch(console.error);
  }
}
