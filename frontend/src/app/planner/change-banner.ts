import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { ConstraintPlanner } from '../core/constraint-planner';
import { TripStore } from '../core/trip-store';
import { ConstraintRecord } from '../core/constraint-models';

@Component({
  selector: 'app-change-banner',
  imports: [MatButtonModule, MatProgressBarModule],
  template: `
    @if (planner.busy()) {
      <div class="banner info" role="status">Checking all members’ constraints and preparing an itinerary proposal…</div>
      <mat-progress-bar mode="indeterminate" />
    }
    @if (planner.error(); as error) {
      <div class="banner error" role="alert">{{ error }}</div>
    }
    @if (planner.result(); as result) {
      @if (result.status !== 'sat') {
        <div class="banner" role="status">
          <strong>{{ result.status === 'unsat' ? 'Your constraints conflict' : 'Could not prepare an itinerary proposal' }}</strong>
          @for (explanation of result.explanations; track $index) { <div>{{ explanation }}</div> }
          @for (conflict of result.conflicts; track $index) { <div class="warn">{{ conflictLabel(conflict) }}</div> }
          <p>Your saved itinerary and individual constraints are unchanged. Ask the relevant members to review their constraints, then request a new proposal.</p>
        </div>
      }
    }
    @if (store.preview(); as preview) {
      <div class="banner">
        <div><strong>Itinerary proposal</strong> · {{ preview.summary }}</div>
        <p>Your saved itinerary will only change after you accept this proposal.</p>
        @for (warning of preview.warnings; track $index) { <div class="warn">{{ warning }}</div> }
        @if (planner.proposal(); as proposal) {
          @for (score of proposal.memberScores; track score.uid) {
            <div class="score">{{ memberName(score.uid) }} · Preference match {{ score.score.toFixed(0) }}/100</div>
          }
          <details>
            <summary>Review constraints, daily costs and travel</summary>
            @for (explanation of planner.result()?.explanations ?? []; track $index) {
              <p>{{ explanation }}</p>
            }
          </details>
        }
        <div class="actions">
          <button mat-stroked-button [disabled]="planner.applying()" (click)="planner.dismiss()">Dismiss proposal</button>
          @if (preview.source === 'solver') {
            <button mat-flat-button [disabled]="planner.applying() || planner.busy()" (click)="planner.apply()">
              {{ planner.applying() ? 'Saving…' : 'Accept this proposal' }}
            </button>
          } @else {
            <button mat-flat-button [disabled]="!planner.collection.allConfirmed() || planner.busy()"
                    (click)="planner.suggest()">Suggest an itinerary using our constraints</button>
          }
        </div>
      </div>
    }
  `,
  styles: [`:host{display:block;flex:0 0 auto;max-height:50%;overflow:auto;overflow-wrap:anywhere}
    .banner{background:#fff8e1;border-bottom:1px solid #e7dba8;padding:10px;font-size:12px}
    .info{background:#eef4fb}.error{background:#fdecea;color:#922}
    .warn{color:#805d00;margin-top:4px}.score{color:#555;margin-top:3px}p{margin:6px 0}
    .actions{display:flex;gap:8px;justify-content:flex-end;margin-top:8px;flex-wrap:wrap}`],
})
export class ChangeBanner {
  readonly store = inject(TripStore);
  readonly planner = inject(ConstraintPlanner);
  memberName(uid: string) {
    return this.store.groupPrefs()?.members.find(m => m.uid === uid)?.name ?? 'Member';
  }
  conflictLabel(conflict: { constraintId: string; ownerId: string; message: string }) {
    const record = this.planner.collection.sessions().find(m => m.uid === conflict.ownerId)
      ?.constraints.find(c => c.id === conflict.constraintId);
    return record ? `${this.memberName(record.ownerId)} · ${this.constraintLabel(record)}` : conflict.message;
  }
  private constraintLabel(record: ConstraintRecord) {
    const value = record.value;
    const time = typeof value === 'number'
      ? `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}` : '';
    const title = this.planner.collection.catalog()?.places.find(p => p.id === value)?.title ?? String(value);
    switch (record.kind) {
      case 'budget_max': return `Daily budget up to €${(Number(value) / 100).toFixed(2)}`;
      case 'day_start_min': return `Depart at ${time} or later`;
      case 'day_end_max': return `Return by ${time}`;
      case 'walking_max': return `Daily walking up to ${value} minutes`;
      case 'max_activities': return `Up to ${value} sightseeing visits per day`;
      case 'include_place': return `${title} must be included`;
      case 'exclude_place': return `${title} must be excluded`;
      default: return `Interest: ${value}`;
    }
  }
}
