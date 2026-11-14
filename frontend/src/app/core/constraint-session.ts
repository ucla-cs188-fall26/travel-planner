import { HttpClient } from '@angular/common/http';
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Firestore, collection, doc, onSnapshot, runTransaction } from '@angular/fire/firestore';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './auth';
import { TripStore } from './trip-store';
import {
  ConstraintAnswer, ConstraintRecord, MemberConstraintSession, MemberConstraintSessionSchema,
  SolverCatalog, SolverCatalogSchema,
} from './constraint-models';
import { applyConstraintAnswer, confirmConstraintReview, hasAllConstraintAnswers, newConstraintSession } from './constraint-questions';

@Injectable({ providedIn: 'root' })
export class ConstraintSessionService {
  private db = inject(Firestore);
  private auth = inject(AuthService);
  private store = inject(TripStore);
  private http = inject(HttpClient);
  private sessionState = signal<MemberConstraintSession[]>([]);
  readonly sessions = this.sessionState.asReadonly();
  readonly catalog = signal<SolverCatalog | null>(null);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly reviewDirty = signal(false);
  readonly error = signal<string | null>(null);
  private catalogRequest: Promise<void> | null = null;

  // Changes to stops or messages must not restart the session subscription.
  private context = computed(() => {
    const trip = this.store.activeTrip(), uid = this.auth.user()?.uid;
    if (!trip || !uid || !trip.memberIds.includes(uid)) return null;
    const memberIds = [...trip.memberIds].sort();
    return { tripId: trip.id, uid, memberIds, key: JSON.stringify([trip.id, uid, memberIds]) };
  }, { equal: (a, b) => a?.key === b?.key });

  readonly ownSession = computed(() => {
    const uid = this.context()?.uid;
    return this.sessions().find(s => s.uid === uid) ?? null;
  });
  readonly allConfirmed = computed(() => {
    const context = this.context();
    return !!context && !this.loading() && !this.saving() && !this.reviewDirty() && context.memberIds.length > 0 && context.memberIds.every(uid =>
      this.sessions().some(s => s.uid === uid && s.confirmed && hasAllConstraintAnswers(s)));
  });

  constructor() {
    effect(onCleanup => {
      const context = this.context();
      this.sessionState.set([]);
      this.reviewDirty.set(false);
      this.error.set(null);
      this.loading.set(!!context);
      if (!context) return;
      const unsubscribe = onSnapshot(collection(this.db, 'trips', context.tripId, 'constraintSessions'), snapshot => {
        if (this.context()?.key !== context.key) return;
        const sessions: MemberConstraintSession[] = [];
        let invalid = false;
        for (const row of snapshot.docs) {
          const parsed = MemberConstraintSessionSchema.safeParse(row.data());
          if (!parsed.success || parsed.data.uid !== row.id || parsed.data.constraints.some(c => c.ownerId !== row.id)) {
            invalid = true;
            continue;
          }
          if (context.memberIds.includes(row.id)) sessions.push(parsed.data);
        }
        this.sessionState.set(sessions.sort((a, b) => a.uid.localeCompare(b.uid)));
        this.loading.set(false);
        if (invalid) this.error.set('Some member constraints have an invalid format. Ask the affected member to save them again.');
      }, error => {
        if (this.context()?.key !== context.key) return;
        this.loading.set(false);
        this.error.set(`Could not load constraints: ${error.message}`);
      });
      onCleanup(unsubscribe);
    });
  }

  loadCatalog(): Promise<void> {
    if (this.catalog()) return Promise.resolve();
    if (this.catalogRequest) return this.catalogRequest;
    this.catalogRequest = firstValueFrom(this.http.get('/solver-api/catalog'))
      .then(raw => { this.catalog.set(SolverCatalogSchema.parse(raw)); })
      .catch(error => { this.error.set(`Could not load the sample Paris places: ${error.message}`); })
      .finally(() => { this.catalogRequest = null; });
    return this.catalogRequest;
  }

  saveAnswer(questionId: string, choice: ConstraintAnswer['choice']): Promise<void> {
    return this.writeOwnSession((current, uid) => applyConstraintAnswer(current, uid, questionId, choice, Date.now()));
  }

  confirmReview(constraints: ConstraintRecord[], expectedRevision?: number): Promise<void> {
    return this.writeOwnSession((current, uid) => {
      if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new Error('Your saved constraints have changed. Reload the latest version and review them again.');
      this.validateConstraints(constraints, uid);
      return confirmConstraintReview(current, uid, constraints, Date.now());
    });
  }

  private async writeOwnSession(update: (current: MemberConstraintSession, uid: string) => MemberConstraintSession): Promise<void> {
    const context = this.context();
    if (!context) throw new Error('Sign in with an account that belongs to this trip.');
    if (this.saving()) throw new Error('Your previous answer is being saved. Please wait.');
    this.saving.set(true);
    this.error.set(null);
    try {
      const ref = doc(this.db, 'trips', context.tripId, 'constraintSessions', context.uid);
      await runTransaction(this.db, async transaction => {
        const snapshot = await transaction.get(ref);
        if (this.context()?.key !== context.key) throw new Error('The trip or signed-in account has changed. Please try again.');
        const current = snapshot.exists()
          ? MemberConstraintSessionSchema.parse(snapshot.data())
          : newConstraintSession(context.uid, Date.now());
        const next = MemberConstraintSessionSchema.parse(update(current, context.uid));
        if (next.uid !== context.uid || next.constraints.some(c => c.ownerId !== context.uid)) throw new Error('You can only save your own constraints.');
        transaction.set(ref, next);
      });
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not save your constraints.');
      throw error;
    } finally {
      this.saving.set(false);
    }
  }

  private validateConstraints(constraints: ConstraintRecord[], uid: string) {
    const catalog = this.catalog();
    if (!catalog) throw new Error('Load the sample places before confirming your constraints.');
    const tags = new Set(catalog.places.flatMap(p => p.tags));
    const placeIds = new Set(catalog.places.map(p => p.id));
    for (const c of constraints) {
      if (c.ownerId !== uid) throw new Error('You cannot edit another member\'s constraints.');
      if (['interest', 'include_place', 'exclude_place'].includes(c.kind)) {
        const valid = c.kind === 'interest' ? tags : placeIds;
        if (typeof c.value !== 'string' || !valid.has(c.value)) throw new Error('This interest or place is not in the sample catalog.');
      } else {
        if (typeof c.value !== 'number' || !Number.isSafeInteger(c.value) || c.value < 0) throw new Error('Enter limits as non-negative whole numbers.');
        const bounds: Record<string, [number, number, string]> = {
          budget_max: [0, 1_000_000, 'Enter a daily budget between €0 and €10,000.'],
          day_start_min: [0, 1439, 'Enter a departure time between 00:00 and 23:59.'],
          day_end_max: [1, 1440, 'Enter a return time of 00:01 or later.'],
          walking_max: [0, 1440, 'Enter a daily walking limit between 0 and 1440 minutes.'],
          max_activities: [0, 20, 'Enter a daily visit limit between 0 and 20.'],
        };
        const [min, max, message] = bounds[c.kind];
        if (c.value < min || c.value > max) throw new Error(message);
      }
    }
    const start = constraints.find(c => c.kind === 'day_start_min')?.value;
    const end = constraints.find(c => c.kind === 'day_end_max')?.value;
    if (typeof start === 'number' && typeof end === 'number' && start >= end) throw new Error('The activity end time must be later than the start time.');
  }
}
