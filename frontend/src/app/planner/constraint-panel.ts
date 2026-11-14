import { Component, computed, effect, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { AuthService } from '../core/auth';
import { TripStore } from '../core/trip-store';
import { ConstraintSessionService } from '../core/constraint-session';
import { ConstraintAnswer, ConstraintKind, ConstraintRecord } from '../core/constraint-models';
import { CONSTRAINT_QUESTIONS, hasAllConstraintAnswers } from '../core/constraint-questions';

type NumericKind = 'budget_max' | 'day_start_min' | 'day_end_max' | 'walking_max' | 'max_activities';
interface ReviewDraft {
  budgetEuros: number | null;
  dayStart: string;
  dayEnd: string;
  walking: number | null;
  activities: number | null;
  hard: Record<NumericKind, boolean>;
  interests: string[];
  places: Record<string, { choice: 'none' | 'include' | 'exclude'; hard: boolean }>;
}

@Component({
  selector: 'app-constraint-panel',
  imports: [FormsModule, MatButtonModule, MatCheckboxModule, MatExpansionModule,
    MatFormFieldModule, MatInputModule, MatSelectModule],
  templateUrl: './constraint-panel.html',
  styleUrl: './constraint-panel.scss',
})
export class ConstraintPanel {
  readonly sessions = inject(ConstraintSessionService);
  readonly store = inject(TripStore);
  private auth = inject(AuthService);
  readonly suggest = output<void>();
  readonly questions = CONSTRAINT_QUESTIONS;
  readonly editingQuestion = signal<string | null>(null);
  readonly localError = signal<string | null>(null);
  readonly draftDirty = this.sessions.reviewDirty;
  readonly reviewConflict = signal(false);
  readonly canReview = computed(() => hasAllConstraintAnswers(this.sessions.ownSession()));
  readonly answeredCount = computed(() => this.questions.filter(q => this.sessions.ownSession()?.answers.some(a => a.questionId === q.id)).length);
  readonly activeQuestion = computed(() => {
    const editing = this.editingQuestion();
    return editing ? this.questions.find(q => q.id === editing) ?? null
      : this.questions.find(q => !this.sessions.ownSession()?.answers.some(a => a.questionId === q.id)) ?? null;
  });
  readonly tags = computed(() => [...new Set(this.sessions.catalog()?.places.flatMap(p => p.tags) ?? [])].sort());
  draft = this.emptyDraft();
  private hydratedKey = '';
  private hydratedIdentity = '';
  private reviewRevision = 0;
  private hydratedCatalogId = '';

  constructor() {
    void this.sessions.loadCatalog();
    effect(() => {
      const session = this.sessions.ownSession();
      const uid = this.auth.user()?.uid ?? '';
      const identity = JSON.stringify([this.store.activeTripId(), uid]);
      const key = JSON.stringify([identity, session?.revision ?? 0]);
      if (this.hydratedKey === key) return;
      if (this.hydratedIdentity === identity && this.draftDirty()) {
        this.reviewConflict.set(true);
        this.localError.set('Your saved constraints changed in another window. Your edits are still here. Load the latest constraints and review them again.');
        return;
      }
      this.hydratedKey = key;
      this.hydratedIdentity = identity;
      this.reviewRevision = session?.revision ?? 0;
      this.reviewConflict.set(false);
      this.editingQuestion.set(null);
      this.localError.set(null);
      this.draftDirty.set(false);
      const records = session?.constraints ?? [];
      const numeric = (kind: NumericKind) => {
        const v = records.find(c => c.kind === kind)?.value;
        return typeof v === 'number' ? v : null;
      };
      const budget = numeric('budget_max');
      this.draft = {
        budgetEuros: budget === null ? null : budget / 100,
        dayStart: this.formatTime(numeric('day_start_min')),
        dayEnd: this.formatTime(numeric('day_end_max')),
        walking: numeric('walking_max'), activities: numeric('max_activities'),
        hard: {
          budget_max: records.some(c => c.kind === 'budget_max' && c.hard),
          day_start_min: records.some(c => c.kind === 'day_start_min' && c.hard),
          day_end_max: records.some(c => c.kind === 'day_end_max' && c.hard),
          walking_max: records.some(c => c.kind === 'walking_max' && c.hard),
          max_activities: records.some(c => c.kind === 'max_activities' && c.hard),
        },
        interests: records.filter(c => c.kind === 'interest').map(c => String(c.value)),
        places: Object.fromEntries(records.filter(c => ['include_place', 'exclude_place'].includes(c.kind)).map(c => [
          String(c.value), { choice: c.kind === 'include_place' ? 'include' as const : 'exclude' as const, hard: c.hard },
        ])),
      };
      this.ensurePlaceDrafts();
    });
    effect(() => {
      const id = this.sessions.catalog()?.id ?? '';
      if (id === this.hydratedCatalogId) return;
      this.hydratedCatalogId = id;
      this.ensurePlaceDrafts();
    });
  }

  markDirty() { this.draftDirty.set(true); this.localError.set(null); }

  reloadReview() { this.draftDirty.set(false); }

  async answer(questionId: string, choice: ConstraintAnswer['choice']) {
    this.localError.set(null);
    try { await this.sessions.saveAnswer(questionId, choice); this.editingQuestion.set(null); }
    catch (error) { this.localError.set(error instanceof Error ? error.message : 'Could not save your answer.'); }
  }

  answerLabel(questionId: string): string {
    const answer = this.sessions.ownSession()?.answers.find(a => a.questionId === questionId);
    const question = this.questions.find(q => q.id === questionId);
    if (!answer || !question) return 'Not answered';
    return answer.choice === 'indifferent' ? 'No preference' : question[answer.choice].label;
  }

  memberName(uid: string): string {
    return this.store.groupPrefs()?.members.find(m => m.uid === uid)?.name ?? (uid === this.auth.user()?.uid ? 'Me' : `Member ${uid.slice(0, 6)}`);
  }

  memberProgress(uid: string): string {
    const session = this.sessions.sessions().find(s => s.uid === uid);
    if (session?.confirmed && hasAllConstraintAnswers(session)) return 'Confirmed';
    const count = this.questions.filter(q => session?.answers.some(a => a.questionId === q.id)).length;
    return `${count}/${this.questions.length} answered · Not confirmed`;
  }

  toggleInterest(tag: string, checked: boolean) {
    this.draft.interests = checked ? [...new Set([...this.draft.interests, tag])] : this.draft.interests.filter(t => t !== tag);
    this.markDirty();
  }

  tagLabel(tag: string): string {
    const labels: Record<string, string> = { art: 'Art', history: 'History', nature: 'Nature', food: 'Food', culture: 'Culture' };
    return labels[tag] ?? tag;
  }

  async confirm() {
    this.localError.set(null);
    try {
      const uid = this.auth.user()?.uid;
      if (!uid) throw new Error('Sign in to confirm your constraints.');
      const constraints: ConstraintRecord[] = [];
      const previous = this.sessions.ownSession()?.constraints ?? [];
      const add = (kind: ConstraintKind, value: number | string | null, hard: boolean) => {
        if (value === null || value === '') return;
        const old = previous.find(c => c.kind === kind && (['interest', 'include_place', 'exclude_place'].includes(kind) ? c.value === value : true));
        constraints.push({
          id: old?.id ?? `${uid}:review:${kind}:${value}`, ownerId: uid, kind, value, hard,
          sourceQuestionId: old?.value === value ? old.sourceQuestionId : null,
        });
      };
      const euros = this.draft.budgetEuros;
      if (euros !== null && (!Number.isFinite(euros) || Math.abs(euros * 100 - Math.round(euros * 100)) > 0.00001)) {
        throw new Error('Enter your budget in euros with up to two decimal places.');
      }
      add('budget_max', euros === null ? null : Math.round(euros * 100), this.draft.hard.budget_max);
      add('day_start_min', this.parseTime(this.draft.dayStart), this.draft.hard.day_start_min);
      add('day_end_max', this.parseTime(this.draft.dayEnd), this.draft.hard.day_end_max);
      add('walking_max', this.draft.walking, this.draft.hard.walking_max);
      add('max_activities', this.draft.activities, this.draft.hard.max_activities);
      this.draft.interests.forEach(tag => add('interest', tag, false));
      for (const [id, place] of Object.entries(this.draft.places)) {
        if (place.choice !== 'none') add(place.choice === 'include' ? 'include_place' : 'exclude_place', id, place.hard);
      }
      if (this.reviewConflict()) throw new Error('Load the latest constraints and review them again.');
      await this.sessions.confirmReview(constraints, this.reviewRevision);
      this.draftDirty.set(false);
    } catch (error) { this.localError.set(error instanceof Error ? error.message : 'Could not save your reviewed constraints.'); }
  }

  requestSuggestion() {
    if (this.sessions.allConfirmed() && !this.draftDirty() && !!this.sessions.catalog() && !this.sessions.saving()) this.suggest.emit();
  }

  private ensurePlaceDrafts() {
    for (const place of this.sessions.catalog()?.places ?? []) {
      this.draft.places[place.id] ??= { choice: 'none', hard: false };
    }
  }

  private formatTime(minutes: number | null): string {
    return minutes === null ? '' : `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }

  private parseTime(time: string): number | null {
    if (!time) return null;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Enter a time between 00:00 and 23:59.');
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
  }

  private emptyDraft(): ReviewDraft {
    return {
      budgetEuros: null, dayStart: '', dayEnd: '', walking: null, activities: null,
      hard: { budget_max: false, day_start_min: false, day_end_max: false, walking_max: false, max_activities: false },
      interests: [], places: {},
    };
  }
}
