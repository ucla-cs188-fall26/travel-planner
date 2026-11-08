// core/trip-store.ts
import { Injectable, computed, signal } from '@angular/core';
import { ChatMessage, Comparison, GroupPreferences, Question, Stop, Trip } from './models';

//shared collection of trip data that the rest of the application reads from
@Injectable({ providedIn: 'root' })
export class TripStore {
  //state
  readonly trips = signal<Trip[]>([]); //all trips the user belongs to
  readonly activeTripId = signal<string | null>(null); //currently opened trip in planner
  readonly messages = signal<ChatMessage[]>([]); //chat history
  readonly selectedStopId = signal<string | null>(null); //selected stop on map and calendar
  readonly dayFilter = signal<number | null>(null); //map day filter
  readonly groupPrefs = signal<GroupPreferences | null>(null); //merged group preferences
  readonly pendingQuestion = signal<Question | null>(null); //follow-up question waiting for an answer
  readonly pendingComparison = signal<Comparison | null>(null); //preference comparison waiting for a pick
  readonly loading = signal(false);

  //changes preview shown by LLM before user accepts
  readonly preview = signal<{ summary: string; stops: Stop[]; warnings: string[] } | null>(null);
  private snapshotBeforeEdit: Stop[] | null = null;
  private history: Stop[][] = [];

  //derived state
  readonly activeTrip = computed(() => this.trips().find(t => t.id === this.activeTripId()) ?? null);
  readonly stops = computed(() => this.preview()?.stops ?? this.activeTrip()?.stops ?? []);
  readonly visibleStops = computed(() => {
    const d = this.dayFilter();
    return d == null ? this.stops() : this.stops().filter(s => s.day === d);
  });
  readonly days = computed(() => [...new Set(this.stops().map(s => s.day))].sort((a, b) => a - b));
  readonly selectedStop = computed(() => this.stops().find(s => s.id === this.selectedStopId()) ?? null);

  //trip actions: managing and switching between trips
  //replace entire trip list with trips
  setTrips(trips: Trip[]) { this.trips.set(trips); }

  //add trip to list if new, otherwise replace with ID
  upsertTrip(trip: Trip) {
    this.trips.update(list => {
      const i = list.findIndex(t => t.id === trip.id);
      return i === -1 ? [...list, trip] : list.map(t => (t.id === trip.id ? trip : t));
    });
  }

  //remove a trip from list and clear selection if opened
  removeTrip(id: string) {
    this.trips.update(l => l.filter(t => t.id !== id));
    if (this.activeTripId() === id) this.activeTripId.set(null);
  }

  //open current trip selected and reset state from previously selecte trip
  selectTrip(id: string) {
    this.activeTripId.set(id);
    this.selectedStopId.set(null);
    this.dayFilter.set(null);
    this.preview.set(null);
    this.history = [];
  }

  //merge partial changes to currently opened trip
  patchActiveTrip(patch: Partial<Trip>) {
    const t = this.activeTrip();
    if (t) this.upsertTrip({ ...t, ...patch });
  }

  // stop actions: itinerary edits with undo feature
  //replace the itinerary while storing previous stops  
  setStops(stops: Stop[], recordHistory = true) {
    const t = this.activeTrip();
    if (!t) return;
    if (recordHistory) this.history.push(t.stops);
    this.upsertTrip({ ...t, stops });
  }

  //updating/editing a single stop
  updateStop(id: string, patch: Partial<Stop>) {
    const t = this.activeTrip();
    if (!t) return;
    if (!this.snapshotBeforeEdit) this.snapshotBeforeEdit = t.stops;
    this.setStops(t.stops.map(s => (s.id === id ? { ...s, ...patch } : s)));
  }

  //restore the previous itinerary
  undo() {
    const prev = this.history.pop();
    if (prev) this.setStops(prev, false);
  }

  //change preview actions: accept/revert
  //Show LLM's proposed itinerary without finalizing it
  showPreview(summary: string, stops: Stop[], warnings: string[]) {
    this.preview.set({ summary, stops, warnings });
  }

  //apply the proposed stops output and clear preview
  acceptPreview() {
    const p = this.preview();
    if (!p) return;
    this.preview.set(null);
    this.setStops(p.stops);
    this.snapshotBeforeEdit = null;
  }

  //discard the current changes and revert to original
  revertPreview() {
    this.preview.set(null);
    if (this.snapshotBeforeEdit) this.setStops(this.snapshotBeforeEdit, false);
    this.snapshotBeforeEdit = null;
  }

  //chat actions
  addMessage(m: ChatMessage) { this.messages.update(l => [...l, m]); }
  setMessages(m: ChatMessage[]) { this.messages.set(m); }
}