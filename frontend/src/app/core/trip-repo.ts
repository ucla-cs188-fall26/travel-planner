import { Injectable, effect, inject } from '@angular/core';
import { Firestore, collection, collectionData, doc, addDoc, setDoc, updateDoc, deleteDoc,
         query, where, orderBy, getDocs, limit, serverTimestamp,
       } from '@angular/fire/firestore';
import { Subscription } from 'rxjs';
import { AuthService } from './auth';
import { TripStore } from './trip-store';
import { ChatMessage, Trip, TripSchema } from './models';

// Input from the new-trip dialog
export interface NewTripInput {
  name: string; destination: string; startDate: string; endDate: string;
  anchors: string[]; memberEmails: string[];
}

// All Firestore access for trips and chat
@Injectable({ providedIn: 'root' })
export class TripRepo {
  private db = inject(Firestore);
  private auth = inject(AuthService);
  private store = inject(TripStore);
  private tripsSub?: Subscription;

  constructor() {
    //List of trips the signed-in user belongs to; updates the store on every change
    effect(() => {
      const uid = this.auth.user()?.uid;
      this.tripsSub?.unsubscribe();
      if (!uid) { this.store.setTrips([]); return; }
      const q = query(collection(this.db, 'trips'), where('memberIds', 'array-contains', uid));
      this.tripsSub = collectionData(q, { idField: 'id' }).subscribe(rows => {
        const trips = rows.flatMap(r => { //Skip any that fails validation
          const p = TripSchema.safeParse(r);
          if (!p.success) console.warn('[repo] invalid trip', r, p.error.issues);
          return p.success ? [p.data] : [];
        });
        this.store.setTrips(trips);
      });
    });
  }

  // Create a trip from the initial questionnaire
  async createTrip(input: NewTripInput): Promise<string> {
    const uid = this.requireUid();
    const memberIds = [...new Set([uid, ...(await this.lookupUids(input.memberEmails))])];
    const ref = await addDoc(collection(this.db, 'trips'), {
      name: input.name,
      ownerId: uid,
      memberIds,
      startDate: input.startDate,
      endDate: input.endDate,
      status: 'gathering',
      details: { destination: input.destination, startDate: input.startDate, endDate: input.endDate },
      anchors: input.anchors,
      overrides: {},
      stops: [],
      createdAt: serverTimestamp(),
    });
    return ref.id;
  }

  // Copy an existing trip into the user's account
  async importTrip(trip: Trip): Promise<string> {
    const uid = this.requireUid();
    const { id: _ignore, ...rest } = trip;
    const ref = await addDoc(collection(this.db, 'trips'), {
      ...rest, ownerId: uid, memberIds: [uid], createdAt: serverTimestamp(),
    });
    return ref.id;
  }

  // Save partial changes to a trip (name, details, stops, status…)
  updateTrip(id: string, patch: Partial<Trip>) {
    const { id: _ignore, ...rest } = patch;
    return updateDoc(doc(this.db, 'trips', id), rest);
  }

  // Save the active trip's current stops
  saveActiveStops() {
    const t = this.store.activeTrip();
    return t ? this.updateTrip(t.id, { stops: t.stops }) : Promise.resolve();
  }

  deleteTrip(id: string) { return deleteDoc(doc(this.db, 'trips', id)); }

  // Store chat message under trips/{tripId}/messages
  saveMessage(tripId: string, m: ChatMessage) {
    return setDoc(doc(this.db, 'trips', tripId, 'messages', m.id), m);
  }

  // When a trip opens, load its chat history
  async loadTripContext(tripId: string) {
    this.store.setMessages([]);
    const snap = await getDocs(query(collection(this.db, 'trips', tripId, 'messages'), orderBy('createdAt'), limit(200)));
    this.store.setMessages(snap.docs.map(d => d.data() as ChatMessage));
  }

  // retrieve UIDs of users who have signed in at least once
  private async lookupUids(emails: string[]): Promise<string[]> {
    const clean = [...new Set(emails.map(e => e.trim().toLowerCase()).filter(Boolean))];
    if (!clean.length) return [];
    const snap = await getDocs(query(collection(this.db, 'users'), where('email', 'in', clean.slice(0, 30))));
    return snap.docs.map(d => d.id);
  }

  private requireUid(): string {
    const uid = this.auth.user()?.uid;
    if (!uid) throw new Error('Not signed in');
    return uid;
  }
}