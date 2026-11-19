import { Component, computed, inject, signal } from '@angular/core';
import { AbstractControl, FormBuilder, ReactiveFormsModule, ValidationErrors, Validators } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { differenceInCalendarDays, format, isValid, parseISO } from 'date-fns';
import { TripStore } from '../core/trip-store';
import { TripRepo } from '../core/trip-repo';
import { ChangeLoop } from '../core/change-loop';
import { Stop } from '../core/models';

export interface StopDetailsData {
  tripId: string;
  startDate: string;
  endDate: string;
  stop: Stop;
}

function clockMinutes(value: string): number {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return NaN;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

@Component({
  selector: 'app-stop-details-dialog',
  imports: [ReactiveFormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatIconModule],
  template: `
    <h2 mat-dialog-title>{{ stop()?.title ?? data.stop.title }}</h2>
    <form [formGroup]="form" (ngSubmit)="save()">
      <mat-dialog-content>
        @if (stop(); as s) {
          <div class="place">{{ s.place.name }}</div>
          @if (s.place.address) { <div class="address">{{ s.place.address }}</div> }
          <div class="meta">Day {{ s.day }} @if (s.priceRange) { · {{ s.priceRange }} }</div>
          @if (s.notes) { <p class="notes">{{ s.notes }}</p> }
          @if (s.sourceUrl) { <a [href]="s.sourceUrl" target="_blank" rel="noopener">View source ↗</a> }

          <div class="time-heading">Date & time</div>
          <p class="time-help">All times are local to your destination.</p>
          @if (blocked()) {
            <p class="notice">Finish the current planning request or accept/revert the calendar change before editing.</p>
          } @else if (s.locked) {
            <p class="notice">This activity's time is locked. Unlock it below to change the date or time.</p>
          }
          <mat-form-field class="date">
            <mat-label>Date</mat-label>
            <input matInput type="date" formControlName="date" [min]="data.startDate" [max]="data.endDate"
                   [readonly]="s.locked || blocked() || saving()" />
          </mat-form-field>
          <div class="times">
            <mat-form-field>
              <mat-label>Start time</mat-label>
              <input matInput type="time" step="60" formControlName="startTime"
                     [readonly]="s.locked || blocked() || saving()" />
            </mat-form-field>
            <mat-form-field>
              <mat-label>End time</mat-label>
              <input matInput type="time" step="60" formControlName="endTime"
                     [readonly]="s.locked || blocked() || saving()" />
            </mat-form-field>
          </div>
          @if (form.errors?.['dateRange']) {
            <p class="error" role="alert">Choose a date within this trip ({{ data.startDate }}–{{ data.endDate }}).</p>
          } @else if (form.errors?.['duration']) {
            <p class="error" role="alert">End time must be after start time. Activities must last 15 minutes to 12 hours on the same day.</p>
          } @else if (form.valid) {
            <div class="duration">Duration: {{ durationMinutes() }} minutes</div>
          }
          <button mat-button type="button" class="lock" (click)="toggleLock()"
                  [disabled]="blocked() || saving() || (!s.locked && timeChanged())">
            <mat-icon>{{ s.locked ? 'lock_open' : 'lock' }}</mat-icon>
            {{ s.locked ? 'Unlock time' : 'Lock this time' }}
          </button>
          @if (!s.locked && timeChanged()) { <p class="time-help">Save your time changes before locking this activity.</p> }
        }
        @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-button type="button" mat-dialog-close [disabled]="saving()">Close</button>
        <button mat-flat-button type="submit" [disabled]="form.invalid || !timeChanged() || stop()?.locked || blocked() || saving()">
          {{ saving() ? 'Saving…' : 'Save time' }}
        </button>
      </mat-dialog-actions>
    </form>`,
  styles: [`
    mat-dialog-content{overflow-wrap:anywhere}
    .place{font-weight:500}.address,.meta{color:#666;margin-top:4px;font-size:13px}
    .notes{white-space:pre-line;line-height:1.6;margin:16px 0}
    .time-heading{font-weight:600;margin-top:24px}.time-help{font-size:13px;color:#666;margin:4px 0 16px}
    .date{width:100%}.times{display:flex;gap:12px}.times>*{flex:1;min-width:0}
    .notice{background:#fff8e1;padding:10px 12px;font-size:13px;line-height:1.5;border-radius:6px}
    .duration{font-size:13px;color:#555;margin-top:-8px}.lock{margin-top:12px}
    .error{color:#b00020;font-size:13px;line-height:1.5}
    @media(max-width:420px){.times{flex-direction:column;gap:0}}
  `],
})
export class StopDetailsDialog {
  readonly data = inject<StopDetailsData>(MAT_DIALOG_DATA);
  private ref = inject(MatDialogRef<StopDetailsDialog>);
  private store = inject(TripStore);
  private repo = inject(TripRepo);
  private change = inject(ChangeLoop);
  private fb = inject(FormBuilder);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly stop = computed(() => this.store.activeTripId() === this.data.tripId
    ? this.store.stops().find(s => s.id === this.data.stop.id) ?? null : null);
  readonly blocked = computed(() => !this.stop() || this.store.loading() || !!this.store.preview()
    || this.store.changeStatus() !== 'idle');

  readonly form = this.fb.nonNullable.group({
    date: [this.data.stop.start.slice(0, 10), Validators.required],
    startTime: [this.data.stop.start.slice(11, 16), Validators.required],
    endTime: [this.data.stop.end.slice(11, 16), Validators.required],
  }, { validators: (control: AbstractControl): ValidationErrors | null => {
    const { date, startTime, endTime } = control.getRawValue();
    const parsed = parseISO(date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isValid(parsed) || format(parsed, 'yyyy-MM-dd') !== date
        || date < this.data.startDate || date > this.data.endDate) return { dateRange: true };
    const duration = clockMinutes(endTime) - clockMinutes(startTime);
    return !Number.isFinite(duration) || duration < 15 || duration > 720 ? { duration: true } : null;
  } });

  durationMinutes(): number {
    const { startTime, endTime } = this.form.getRawValue();
    return clockMinutes(endTime) - clockMinutes(startTime);
  }

  timeChanged(): boolean {
    const { date, startTime, endTime } = this.form.getRawValue();
    const stop = this.stop();
    return !!stop && (date !== stop.start.slice(0, 10) || startTime !== stop.start.slice(11, 16)
      || date !== stop.end.slice(0, 10) || endTime !== stop.end.slice(11, 16));
  }

  async toggleLock() {
    const stop = this.stop();
    if (!stop || this.blocked() || this.saving() || (!stop.locked && this.timeChanged())) return;
    this.saving.set(true);
    this.error.set(null);
    this.ref.disableClose = true;
    this.store.updateStop(stop.id, { locked: !stop.locked });
    try {
      await this.repo.saveActiveStops();
      if (this.store.activeTripId() === this.data.tripId) this.store.clearEditSnapshot();
    } catch (e: any) {
      if (this.store.activeTripId() === this.data.tripId) this.store.revertPreview();
      this.error.set(e?.message ?? 'Could not save the lock setting. Try again.');
    } finally {
      this.saving.set(false);
      this.ref.disableClose = false;
    }
  }

  async save() {
    this.form.markAllAsTouched();
    const stop = this.stop();
    if (!stop || this.blocked() || this.saving() || stop.locked || this.form.invalid || !this.timeChanged()) return;
    const { date, startTime, endTime } = this.form.getRawValue();
    const start = `${date}T${startTime}:00`, end = `${date}T${endTime}:00`;
    const day = differenceInCalendarDays(parseISO(date), parseISO(this.data.startDate)) + 1;
    this.saving.set(true);
    this.error.set(null);
    this.ref.disableClose = true;
    this.store.updateStop(stop.id, { start, end, day });
    try {
      await this.repo.saveActiveStops();
      if (this.store.activeTripId() === this.data.tripId) {
        this.change.push({ stopId: stop.id, from: { start: stop.start, end: stop.end }, to: { start, end } });
      }
      this.ref.close();
    } catch (e: any) {
      if (this.store.activeTripId() === this.data.tripId) this.store.revertPreview();
      this.error.set(e?.message ?? 'Could not save this time. Try again.');
    } finally {
      this.saving.set(false);
      this.ref.disableClose = false;
    }
  }
}
