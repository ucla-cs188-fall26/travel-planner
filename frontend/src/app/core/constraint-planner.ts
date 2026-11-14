import { HttpClient } from '@angular/common/http';
import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { doc, Firestore, runTransaction } from '@angular/fire/firestore';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './auth';
import { ConstraintSessionService } from './constraint-session';
import { MemberConstraintSessionSchema, SolverProposal, SolverResponse, SolverResponseSchema } from './constraint-models';
import { EditDiff, TripSchema } from './models';
import { planningSignature, planningVersion } from './planning-input';
import { TripStore } from './trip-store';

@Injectable({ providedIn: 'root' })
export class ConstraintPlanner {
  private http = inject(HttpClient);
  private db = inject(Firestore);
  private auth = inject(AuthService);
  private store = inject(TripStore);
  readonly collection = inject(ConstraintSessionService);
  readonly busy = signal(false);
  readonly applying = signal(false);
  readonly error = signal<string | null>(null);
  readonly result = signal<SolverResponse | null>(null);
  readonly proposal = computed(() => this.result()?.proposal ?? null);
  private signature: string | null = null;
  private sequence = 0;
  private contextTripId: string | null = null;

  constructor() {
    effect(() => {
      const trip = this.store.activeTrip();
      const catalog = this.collection.catalog();
      const sessions = this.collection.sessions();
      const uid = this.auth.user()?.uid;
      const reviewDirty = this.collection.reviewDirty();
      const allConfirmed = this.collection.allConfirmed();
      if (this.contextTripId !== (trip?.id ?? null)) {
        this.contextTripId = trip?.id ?? null;
        this.sequence++;
        this.signature = null;
        this.result.set(null);
        this.error.set(null);
        this.busy.set(false);
        this.store.revertPreview();
      }
      if (this.signature && (!trip || !catalog || !uid || reviewDirty || !allConfirmed ||
          planningSignature(trip, sessions, catalog.id) !== this.signature)) {
        this.sequence++;
        this.signature = null;
        this.result.set(null);
        if (this.store.preview()?.source === 'solver') this.store.revertPreview();
        this.error.set('The trip or member constraints have changed. Request a new proposal using the latest constraints.');
        this.busy.set(false);
      }
    });
  }

  async suggest(requestedEdits: EditDiff[] = []) {
    const trip = this.store.activeTrip();
    const catalog = this.collection.catalog();
    if (!trip || !catalog || !this.auth.user()) return;
    if (!this.collection.allConfirmed()) {
      this.error.set('Every member must confirm their constraints before requesting an itinerary.');
      return;
    }
    if (this.applying() || this.busy()) return;
    const members = structuredClone(this.collection.sessions());
    const snapshot = structuredClone(trip);
    const signature = planningSignature(snapshot, members, catalog.id);
    this.signature = signature;
    const run = ++this.sequence;
    this.busy.set(true);
    this.error.set(null);
    this.result.set(null);
    this.store.revertPreview();
    try {
      const inputVersion = await planningVersion(signature);
      if (run !== this.sequence) return;
      const raw = await firstValueFrom(this.http.post('/solver-api/solve', {
        trip: snapshot, members, catalogId: catalog.id, inputVersion, requestedEdits,
      }));
      if (run !== this.sequence || !this.isCurrent(signature)) return;
      const response = SolverResponseSchema.parse(raw);
      if (response.proposal && (response.status !== 'sat' || response.proposal.inputVersion !== inputVersion ||
          response.proposal.tripId !== trip.id || response.proposal.catalogId !== catalog.id)) {
        throw new Error('The proposal does not match the current trip inputs. Request a new proposal.');
      }
      this.result.set(response);
      if (response.status === 'sat' && response.proposal) {
        this.store.showPreview(response.proposal.summary, response.proposal.stops,
          response.proposal.warnings, 'solver');
      }
    } catch (e: unknown) {
      if (run === this.sequence) this.error.set(this.message(e, 'Could not connect to the itinerary service. Check that the server on port 3001 is running.'));
    } finally {
      if (run === this.sequence) this.busy.set(false);
    }
  }

  dismiss() {
    this.sequence++;
    this.signature = null;
    this.result.set(null);
    this.error.set(null);
    this.busy.set(false);
    this.store.revertPreview();
  }

  // The only solver path that writes stops. Check live documents in one transaction.
  async apply() {
    const proposal = this.proposal();
    const signature = this.signature;
    const uid = this.auth.user()?.uid;
    if (!proposal || !signature || !uid || this.applying()) return;
    this.applying.set(true);
    this.error.set(null);
    try {
      if (!this.collection.allConfirmed() || !this.isCurrent(signature)) throw new Error('The constraints have changed. Request a new proposal.');
      await this.applyTransaction(proposal, signature, uid);
      // Firestore's subscription publishes the committed trip. No optimistic plan mutation.
      this.signature = null;
      this.result.set(null);
      this.error.set(null);
      this.store.revertPreview();
    } catch (e: unknown) {
      this.error.set(this.message(e, 'Could not save the proposal. Your saved itinerary is unchanged.'));
    } finally {
      this.applying.set(false);
    }
  }

  private async applyTransaction(proposal: SolverProposal, signature: string, uid: string) {
    const tripRef = doc(this.db, 'trips', proposal.tripId);
    await runTransaction(this.db, async tx => {
      const tripDoc = await tx.get(tripRef);
      if (this.auth.user()?.uid !== uid) throw new Error('The signed-in account has changed. Please check your account and try again.');
      if (!tripDoc.exists()) throw new Error('This trip has been deleted.');
      const trip = TripSchema.parse({ ...tripDoc.data(), id: tripDoc.id });
      if (!trip.memberIds.includes(uid)) throw new Error('Only members of this trip can accept a proposal.');
      const members = [];
      for (const memberId of trip.memberIds) {
        const snap = await tx.get(doc(this.db, 'trips', trip.id, 'constraintSessions', memberId));
        if (!snap.exists()) throw new Error('Member answers have changed. Request a new proposal.');
        const member = MemberConstraintSessionSchema.parse(snap.data());
        if (member.uid !== memberId || !member.confirmed) throw new Error('Every member must confirm their constraints.');
        members.push(member);
      }
      if (planningSignature(trip, members, proposal.catalogId) !== signature) {
        throw new Error('The constraints or itinerary have changed. Request a new proposal using the latest inputs.');
      }
      if (this.auth.user()?.uid !== uid || !this.isCurrent(signature)) {
        throw new Error('The trip or account has changed. Request a new proposal.');
      }
      tx.update(tripRef, {
        stops: proposal.stops, status: 'planned',
        acceptedProposal: { id: proposal.id, inputVersion: proposal.inputVersion,
          catalogId: proposal.catalogId, acceptedBy: uid, acceptedAt: Date.now() },
      });
    });
  }

  private isCurrent(signature: string) {
    const trip = this.store.activeTrip(), catalog = this.collection.catalog();
    return !!trip && !!catalog && !!this.auth.user() && !this.collection.reviewDirty() &&
      planningSignature(trip, this.collection.sessions(), catalog.id) === signature;
  }

  private message(error: unknown, fallback: string) {
    if (error && typeof error === 'object' && 'status' in error && error.status === 0) return fallback;
    return error instanceof Error ? error.message : fallback;
  }
}
