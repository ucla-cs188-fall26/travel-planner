import { Component, inject, signal } from '@angular/core';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { TripStore } from '../core/trip-store';
import { TripRepo } from '../core/trip-repo';
import { mergeGroupPreferences } from '../core/group-prefs';
import { Preferences } from '../core/models';

// Collapsible panel above the chat w/ members, merged prefs, conflicts, trip-only overrides, add member
@Component({
  selector: 'app-group-prefs-panel',
  imports: [MatExpansionModule, MatChipsModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule],
  template: `
    @if (store.groupPrefs(); as g) {
      <mat-expansion-panel class="panel">
        <mat-expansion-panel-header>
          <mat-panel-title>Group · {{ g.members.length }} {{ g.members.length === 1 ? 'member' : 'members' }}</mat-panel-title>
          @if (g.conflicts.length) { <mat-panel-description class="warn">{{ g.conflicts.length }} conflict(s)</mat-panel-description> }
        </mat-expansion-panel-header>

        <mat-chip-set>@for (m of g.members; track m.uid) { <mat-chip>{{ m.name }}</mat-chip> }</mat-chip-set> <!-- trip members -->

        @if (g.conflicts.length) {
          <ul class="conflicts">@for (c of g.conflicts; track c.field) { <li>⚠️ {{ c.message }}</li> }</ul>
        }

        <div class="merged">
          Budget: {{ g.merged.budgetPerDay != null ? '$' + g.merged.budgetPerDay + '/day' : '—' }} ·
          Hours: {{ g.merged.activeHours ? g.merged.activeHours.start + '–' + g.merged.activeHours.end : '—' }} ·
          Pace: {{ g.merged.pace ?? '—' }} · Dietary: {{ g.merged.dietary.join(', ') || 'none' }}
        </div>

        <h4>Override for this trip only</h4>
        <div class="row">
          <mat-form-field><mat-label>Pace</mat-label>
            <mat-select #pace [value]="g.merged.pace">
              <mat-option value="relaxed">Relaxed</mat-option>
              <mat-option value="balanced">Balanced</mat-option>
              <mat-option value="packed">Packed</mat-option>
            </mat-select></mat-form-field>
          <mat-form-field><mat-label>Budget/day</mat-label>
            <input matInput #budget type="number" [value]="g.merged.budgetPerDay ?? ''" /></mat-form-field>
          <button mat-stroked-button (click)="override(pace.value, budget.value)">Apply</button>
        </div>

        <div class="row">  <!-- Add member by email -->
          <mat-form-field class="grow"><mat-label>Add member by email</mat-label><input matInput #email /></mat-form-field>
          <button mat-stroked-button (click)="add(email.value); email.value = ''">Add</button>
        </div>
        @if (err()) { <div class="warn">{{ err() }}</div> }
      </mat-expansion-panel>
    }`,
  styles: [`.panel{margin:8px 12px 0}.warn{color:#b26a00}.conflicts{padding-left:18px;margin:8px 0}
            .merged{font-size:13px;color:#444;margin:8px 0}h4{margin:12px 0 4px}
            .row{display:flex;gap:8px;align-items:center}.grow{flex:1}`],
})
export class GroupPrefsPanel {
  store = inject(TripStore);
  private repo = inject(TripRepo);
  err = signal<string | null>(null);

  // Save trip-only overrides, then re-merge so the panel and next LLM request use them
  async override(pace: string | undefined, budget: string) {
    const t = this.store.activeTrip(), g = this.store.groupPrefs();
    if (!t || !g) return;
    const overrides: Partial<Preferences> = { ...t.overrides };
    if (pace) overrides.pace = pace as Preferences['pace'];
    if (budget) overrides.budgetPerDay = Number(budget); else delete overrides.budgetPerDay;
    this.store.patchActiveTrip({ overrides });
    this.store.groupPrefs.set(mergeGroupPreferences(g.members, overrides));
    await this.repo.updateTrip(t.id, { overrides });
  }

  // Add a member, or shown an error if they haven't signed in yet
  async add(email: string) {
    const t = this.store.activeTrip();
    if (!t || !email.trim()) return;
    this.err.set(null);
    try { await this.repo.addMember(t.id, email.trim()); }
    catch (e: any) { this.err.set(e.message); }
  }
}