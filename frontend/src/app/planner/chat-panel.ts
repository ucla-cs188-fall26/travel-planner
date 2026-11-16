import { Component, ElementRef, afterRenderEffect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MarkdownComponent } from 'ngx-markdown';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { TripStore } from '../core/trip-store';
import { Api } from '../core/api';
import { TripRepo } from '../core/trip-repo';
import { MapsLoader } from '../core/maps-loader';
import { ComparisonCard } from './comparison-card';
import { ChatMessage, Question, SuggestionDecision, Trip } from '../core/models';
import { GroupPrefsPanel } from './group-prefs-panel'
import { PlaceSuggestions } from './place-suggestions';

// Center pane: conversation with the planner, question tokens, comparison cards
@Component({
  selector: 'app-chat-panel',
  imports: [FormsModule, MarkdownComponent, MatButtonModule, MatChipsModule, MatProgressSpinnerModule, ComparisonCard, GroupPrefsPanel, PlaceSuggestions],
  template: `
    @if (store.activeTrip()) {
      <app-group-prefs-panel />
      <div class="log" #log> <!-- Message history -->
        @if (store.messages().length === 0) {
          <div class="hint">Tell the planner your preferences, or get a first itinerary using your trip details below.</div>
        }
        @for (m of store.messages(); track m.id) {
          <div class="msg" [class.user]="m.role === 'user'">
            <markdown [data]="m.text" (ready)="scrollToLatest()" />
            @if (m.suggestions?.length) {
              <app-place-suggestions [suggestions]="m.suggestions!" [active]="activeProposal(m)" [disabled]="store.loading()"
                                     [canSkip]="m.canSkipSuggestions ?? false"
                                     (accepted)="decideSuggestions(m, $event)" (skipped)="decideSuggestions(m, [])"
                                     (refresh)="suggestItinerary()" />
            }
            @if (m.comparison) {
              <app-comparison-card [comparison]="m.comparison" [disabled]="store.loading()"
                                   (pick)="send('I pick: ' + $event)" />
            }
          </div>
        }
        @if (store.loading()) {
          <div class="msg loading" role="status">
            <mat-spinner diameter="20" aria-hidden="true" />
            <span>Working on your request…</span>
          </div>
        }
        @if (error()) { <div class="error">{{ error() }} <button mat-button (click)="retry()">Retry</button></div> }
      </div>

      @if (store.pendingQuestion(); as q) { <!-- LLM follow-up -->
        <div class="question">
          <div class="q-prompt">{{ q.prompt }}</div>
          @if (q.type === 'single_choice' || q.type === 'multi_choice') {
            <mat-chip-listbox [multiple]="q.type === 'multi_choice'" #chips>
              @for (o of q.options ?? []; track o) { <mat-chip-option [value]="o">{{ o }}</mat-chip-option> }
            </mat-chip-listbox>
            <button mat-flat-button [disabled]="store.loading()" (click)="answer(q, chips.value)">Send</button>
          }
        </div>
      }

      @if (store.activeTrip()!.stops.length === 0 && !store.activeTrip()!.details['pendingProposal']) {
        <div class="first-plan">
          <div>
            <div class="first-plan-title">Your itinerary starts here</div>
            <div class="first-plan-hint">Discover more places, choose your favorites, then build a first itinerary.</div>
          </div>
          <button mat-flat-button type="button" (click)="suggestItinerary()" [disabled]="store.loading()">
            {{ store.loading() ? 'Planning…' : 'Suggest first itinerary' }}
          </button>
        </div>
      }
      <form class="input" (ngSubmit)="send(draft)">
        <textarea [(ngModel)]="draft" name="draft" rows="2" placeholder="Tell the planner what you want…"
                  (keydown.enter)="$event.preventDefault(); send(draft)"></textarea>
        <button mat-flat-button type="submit" [disabled]="!draft.trim() || store.loading()">
          {{ store.loading() ? 'Working…' : 'Send' }}
        </button>
      </form>
    } @else {
      <div class="empty">Create or select a trip to start planning</div>
    }`,
  styles: [`
    :host{display:flex;flex-direction:column;height:100%;min-height:0}
    .log{flex:1;min-height:0;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
    .msg{flex-shrink:0;max-width:80%;padding:10px 14px;border-radius:12px;background:#f1f0ec}
    .msg.user{align-self:flex-end;background:#dbe7f5}
    .loading{display:flex;align-items:center;align-self:flex-start;gap:10px;color:#555}
    .loading mat-spinner{flex-shrink:0}
    .hint{color:#888}
    .question{padding:8px 16px;border-top:1px solid #eee;display:flex;flex-direction:column;gap:6px;align-items:flex-start}
    .q-prompt{font-weight:500}
    .first-plan{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:16px;background:#f1f5fa;border-top:1px solid #dce4ee}
    .first-plan-title{font-weight:600}.first-plan-hint{font-size:13px;color:#555;margin-top:4px}
    .input{display:flex;gap:8px;padding:12px;border-top:1px solid #eee}
    textarea{flex:1;resize:none;font:inherit;padding:8px;border-radius:8px;border:1px solid #ccc}
    .error{color:#b00020}.empty{padding:24px;color:#888}`],
})
export class ChatPanel {
  store = inject(TripStore);
  private api = inject(Api);
  private repo = inject(TripRepo);
  private maps = inject(MapsLoader);
  private log = viewChild<ElementRef<HTMLDivElement>>('log');

  draft = '';
  error = signal<string | null>(null);
  private lastText = ''; 
  private lastDecision?: SuggestionDecision;

  constructor() {
    // Measure after the updated messages and controls have been rendered.
    afterRenderEffect(() => {
      this.store.messages();
      this.store.loading();
      this.store.pendingQuestion();
      this.error();
      this.scrollToLatest();
    });
  }

  // Markdown renders asynchronously and can increase the height after Angular's render.
  scrollToLatest() {
    const el = this.log()?.nativeElement;
    el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }

  // Send a chip answer; also stored directly under the question's field
  answer(q: Question, value: unknown) {
    const text = Array.isArray(value) ? value.join(', ') : String(value ?? '');
    if (text) this.send(text, { [q.field]: value });
  }

  retry() { this.send(this.lastText, {}, this.lastDecision); }

  activeProposal(message: ChatMessage): boolean {
    const trip = this.store.activeTrip();
    return !!message.proposalId && !trip?.stops.length && trip?.details['pendingProposal']?.id === message.proposalId;
  }

  decideSuggestions(message: ChatMessage, acceptedIds: string[]) {
    if (!this.activeProposal(message) || this.store.loading() || (!acceptedIds.length && !message.canSkipSuggestions)) return;
    const chosen = message.suggestions?.filter(p => acceptedIds.includes(p.id)) ?? [];
    const decision: SuggestionDecision = { proposalId: message.proposalId!,
      action: acceptedIds.length ? 'accept' : 'skip', acceptedIds: chosen.map(p => p.id) };
    return this.send(chosen.length
      ? `Include ${chosen.map(p => p.title).join(', ')} alongside my must-dos and build the itinerary.`
      : 'Build the itinerary without these suggested extra places.', {}, decision);
  }

  suggestItinerary() {
    const trip = this.store.activeTrip();
    if (!trip || trip.stops.length || this.store.loading()) return;
    const preferences = this.draft.trim();
    return this.send('Please suggest additional places beyond my must-dos using the trip dates and group preferences already provided. '
      + 'Use reasonable defaults for missing optional preferences and explain your assumptions. '
      + 'Let me choose which suggested places to include before creating the schedule.'
      + (preferences ? ` Additional preferences: ${preferences}` : ''));
  }

  // Main traversal: save user message, call backend, store answers/itinerary, and save LLM message
  async send(text: string, directAnswer: Record<string, unknown> = {}, suggestionDecision?: SuggestionDecision) {
    const trip = this.store.activeTrip();
    if (!trip || !text.trim() || this.store.loading()) return;
    this.lastText = text;
    this.lastDecision = suggestionDecision;
    this.draft = '';
    this.error.set(null);
    this.store.pendingQuestion.set(null);

    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', text, createdAt: Date.now() };
    this.store.addMessage(userMsg);
    this.repo.saveMessage(trip.id, userMsg).catch(console.error);

    this.store.loading.set(true);
    try {
      const res = await this.api.chat({
        message: text,
        trip: { ...trip, details: { ...trip.details, ...directAnswer } },
        groupPreferences: this.store.groupPrefs(),
        recentMessages: this.store.messages().slice(-10),
        suggestionDecision,
      });

      // Answers and extracted facts are written to the trip
      const details = { ...trip.details, ...directAnswer, ...res.extracted };
      let patch: Partial<Trip> = { details, status: res.status };

      // Render the solved itinerary immediately; Maps enrichment must not block the calendar.
      if (res.status === 'ready' && res.itinerary?.length) {
        patch = { ...patch, stops: res.itinerary, status: 'planned',
                  details: { ...details, plannerWarnings: res.warnings } };
      }
      // Responses always belong to the trip that sent them, even if the user switched trips.
      const current = this.store.trips().find(t => t.id === trip.id);
      if (current) this.store.upsertTrip({ ...current, ...patch });
      await this.repo.updateTrip(trip.id, patch);

      const botMsg: ChatMessage = {
        id: crypto.randomUUID(), role: 'assistant', text: res.reply,
        question: res.question ?? null, comparison: res.comparison ?? null, createdAt: Date.now(),
        suggestions: res.suggestions ?? [], proposalId: res.proposalId ?? null,
        canSkipSuggestions: res.canSkipSuggestions ?? false,
      };
      if (this.store.activeTripId() === trip.id) this.store.addMessage(botMsg);
      this.repo.saveMessage(trip.id, botMsg).catch(console.error);
      if (this.store.activeTripId() === trip.id) this.store.pendingQuestion.set(res.question ?? null);
      if (patch.stops) {
        const original = patch.stops;
        void this.maps.resolveStops(original, String(details['destination'] ?? '')).then(async stops => {
          const latest = this.store.trips().find(t => t.id === trip.id);
          const sameSchedule = latest?.stops.length === original.length && latest.stops.every(s =>
            original.some(o => o.id === s.id && o.start === s.start && o.end === s.end));
          if (!latest || !sameSchedule) return;
          const places = new Map(stops.map(s => [s.id, s.place]));
          const enriched = latest.stops.map(s => ({ ...s, place: places.get(s.id) ?? s.place }));
          this.store.upsertTrip({ ...latest, stops: enriched });
          await this.repo.updateTrip(trip.id, { stops: enriched });
        }).catch(console.error);
      }
    } catch (e: any) {
      this.error.set(e?.message ?? 'Something went wrong.');
    } finally {
      this.store.loading.set(false);
    }
  }
}
