import { Component, ElementRef, effect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MarkdownComponent } from 'ngx-markdown';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { TripStore } from '../core/trip-store';
import { Api } from '../core/api';
import { TripRepo } from '../core/trip-repo';
import { MapsLoader } from '../core/maps-loader';
import { ComparisonCard } from './comparison-card';
import { ChatMessage, Question, Trip } from '../core/models';

// Center pane: conversation with the planner, question tokens, comparison cards
@Component({
  selector: 'app-chat-panel',
  imports: [FormsModule, MarkdownComponent, MatButtonModule, MatChipsModule, MatProgressBarModule, ComparisonCard],
  template: `
    @if (store.activeTrip()) {
      <div class="log" #log> <!-- Message history -->
        @if (store.messages().length === 0) {
          <div class="hint">Tell the planner about your trip, e.g. "We want a relaxed 3 days with good food."</div>
        }
        @for (m of store.messages(); track m.id) {
          <div class="msg" [class.user]="m.role === 'user'">
            <markdown [data]="m.text" />
            @if (m.comparison) {
              <app-comparison-card [comparison]="m.comparison" [disabled]="store.loading()"
                                   (pick)="send('I pick: ' + $event)" />
            }
          </div>
        }
        @if (store.loading()) { <mat-progress-bar mode="indeterminate" /> }
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

      <form class="input" (ngSubmit)="send(draft)">
        <textarea [(ngModel)]="draft" name="draft" rows="2" placeholder="Tell the planner what you want…"
                  (keydown.enter)="$event.preventDefault(); send(draft)"></textarea>
        <button mat-flat-button type="submit" [disabled]="!draft.trim() || store.loading()">Send</button>
      </form>
    } @else {
      <div class="empty">Create or select a trip to start planning</div>
    }`,
  styles: [`
    :host{display:flex;flex-direction:column;height:100%;min-height:0}
    .log{flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
    .msg{max-width:80%;padding:10px 14px;border-radius:12px;background:#f1f0ec}
    .msg.user{align-self:flex-end;background:#dbe7f5}
    .hint{color:#888}
    .question{padding:8px 16px;border-top:1px solid #eee;display:flex;flex-direction:column;gap:6px;align-items:flex-start}
    .q-prompt{font-weight:500}
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

  constructor() {
    // Scroll to the newest message whenever the list changes
    effect(() => {
      this.store.messages();
      const el = this.log()?.nativeElement;
      if (el) queueMicrotask(() => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }));
    });
  }

  // Send a chip answer; also stored directly under the question's field
  answer(q: Question, value: unknown) {
    const text = Array.isArray(value) ? value.join(', ') : String(value ?? '');
    if (text) this.send(text, { [q.field]: value });
  }

  retry() { this.send(this.lastText); }

  // Main traversal: save user message, call backend, store answers/itinerary, and save LLM message
  async send(text: string, directAnswer: Record<string, unknown> = {}) {
    const trip = this.store.activeTrip();
    if (!trip || !text.trim() || this.store.loading()) return;
    this.lastText = text;
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
        trip,
        groupPreferences: this.store.groupPrefs(),
        recentMessages: this.store.messages().slice(-10),
      });

      // Answers and extracted facts are written to the trip
      const details = { ...trip.details, ...directAnswer, ...res.extracted };
      let patch: Partial<Trip> = { details, status: res.status };

      // Itinerary: replace LLM's coordinates with ones from Places API
      if (res.status === 'ready' && res.itinerary?.length) {
        const stops = await this.maps.resolveStops(res.itinerary, String(details['destination'] ?? ''));
        patch = { ...patch, stops, status: 'planned' };
      }
      this.store.patchActiveTrip(patch);
      await this.repo.updateTrip(trip.id, patch);

      const botMsg: ChatMessage = {
        id: crypto.randomUUID(), role: 'assistant', text: res.reply,
        question: res.question ?? null, comparison: res.comparison ?? null, createdAt: Date.now(),
      };
      this.store.addMessage(botMsg);
      this.repo.saveMessage(trip.id, botMsg).catch(console.error);
      this.store.pendingQuestion.set(res.question ?? null);
    } catch (e: any) {
      this.error.set(e?.message ?? 'Something went wrong.');
    } finally {
      this.store.loading.set(false);
    }
  }
}