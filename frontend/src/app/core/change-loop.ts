import { Injectable, inject } from '@angular/core';
import { Subject, buffer, debounceTime, filter, share } from 'rxjs';
import { ConstraintPlanner } from './constraint-planner';
import { EditDiff } from './models';
import { TripStore } from './trip-store';

// Calendar gestures request a new proposal. They never persist or optimistically edit stops.
@Injectable({ providedIn: 'root' })
export class ChangeLoop {
  private planner = inject(ConstraintPlanner);
  private store = inject(TripStore);
  private edits$ = new Subject<{ tripId: string; diff: EditDiff }>();

  constructor() {
    const edits = this.edits$.pipe(share());
    edits.pipe(buffer(edits.pipe(debounceTime(900))), filter(batch => batch.length > 0))
      .subscribe(batch => {
        const tripId = this.store.activeTripId();
        const latest = new Map<string, EditDiff>();
        for (const item of batch) {
          if (item.tripId === tripId) latest.set(item.diff.stopId, item.diff);
        }
        if (latest.size) void this.planner.suggest([...latest.values()]);
      });
  }

  push(diff: EditDiff) {
    const tripId = this.store.activeTripId();
    if (tripId) this.edits$.next({ tripId, diff });
  }
}
