import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { TripStore } from '../core/trip-store';
import { TripRepo } from '../core/trip-repo';

// Bar above the calendar to indicate change status of "checking…", the suggested fix with Accept/Revert, or an error note
@Component({
  selector: 'app-change-banner',
  imports: [MatButtonModule, MatProgressBarModule],
  template: `
    @if (store.changeStatus() === 'pending') {  <!-- LLM response wait -->
      <div class="banner info">Checking your change with the planner…</div>
      <mat-progress-bar mode="indeterminate" />
    } @else if (store.changeStatus() === 'error') {                                  <!-- Backend failed: user decides -->
        <div class="banner error">
            <div>Couldn't get a suggestion for this change.</div>
            <div class="actions">
            <button mat-stroked-button (click)="undoChange()">Undo Change</button>
            <button mat-flat-button (click)="keepChange()">Keep My Change</button>
            </div>
        </div>
    } @else if (store.preview(); as p) { <!-- Proposal awaiting a decision -->
      <div class="banner">
        <div><strong>Suggested fix:</strong> {{ p.summary }}</div>
        @for (w of p.warnings; track w) { <div class="warn">⚠️ {{ w }}</div> }
        <div class="actions">
          <button mat-stroked-button (click)="revert()">Revert</button>
          <button mat-flat-button (click)="accept()">Accept</button>
        </div>
      </div>
    }`,
  styles: [`.banner{background:#fff8e1;border-bottom:1px solid #f0d58a;padding:8px 10px;font-size:13px}
            .info{background:#eef4fb;border-color:#c9dcf2}.error{background:#fdecea;border-color:#f5c2bd}
            .warn{color:#8a5a00}.actions{display:flex;gap:8px;justify-content:flex-end;margin-top:6px}`],
})
export class ChangeBanner {
  store = inject(TripStore);
  private repo = inject(TripRepo);

  // Apply the proposal and save it
  accept() { this.store.acceptPreview(); this.repo.saveActiveStops(); }

  // Discard the proposal, restore the stops from before the drag, and save
  revert() { this.store.revertPreview(); this.repo.saveActiveStops(); }

  // Keep the dragged times as they are
    keepChange() {
        this.store.clearEditSnapshot();
        this.store.changeStatus.set('idle');
    }

    // Restore the stops from before the first drag in this batch, and save
    undoChange() {
        this.store.revertPreview(); 
        this.store.changeStatus.set('idle');
        this.repo.saveActiveStops();
    }
}