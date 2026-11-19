import { Component, computed, DestroyRef, effect, inject, untracked, viewChild } from '@angular/core';
import { FullCalendarModule, FullCalendarComponent, CalendarOptions } from '@fullcalendar/angular';
import themePlugin from '@fullcalendar/angular/themes/classic';
import timeGridPlugin from '@fullcalendar/angular/timegrid';
import interactionPlugin from '@fullcalendar/angular/interaction';
import { format, addDays, parseISO, differenceInCalendarDays } from 'date-fns';
import { MatButtonModule } from '@angular/material/button';
import { TripStore } from '../core/trip-store';
import { TripRepo } from '../core/trip-repo';
import { ChangeLoop } from '../core/change-loop';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { StopDetailsData, StopDetailsDialog } from './stop-details-dialog';
import { PlanningNotes } from './planning-notes';

// Converts FullCalendar returned value into a set format
function toLocal(v: unknown): string {
  if (v instanceof Date) return format(v, "yyyy-MM-dd'T'HH:mm:ss");
  return String(v).slice(0, 19);
}

// Event color per stop category
const CATEGORY_COLORS: Record<string, string> = {
  food: '#e07a5f', sight: '#3d5a80', activity: '#81b29a', transit: '#9e9e9e', lodging: '#6d597a', free: '#c9a227',
};

// Top-right pane: time grid for the trip days, with drag, resize and click-to-select
@Component({
  selector: 'app-calendar-panel',
  imports: [FullCalendarModule, MatButtonModule, PlanningNotes],
  template: `
    <div class="bar">  <!-- Small toolbar above the calendar -->
      @if (planningWarnings().length) { <app-planning-notes [warnings]="planningWarnings()" /> }
      <button mat-button (click)="store.undo(); repo.saveActiveStops()">Undo</button>
    </div>
    @if (store.activeTrip()) {
      <full-calendar [options]="options()" /> 
    } @else {
      <div class="empty">Select or create a trip</div>
    }`,
  styles: [`:host{display:flex;flex-direction:column;flex:1;min-height:0}
            .bar{display:flex;justify-content:flex-end;align-items:center;flex-wrap:wrap;gap:4px;padding:2px 6px}
            .bar app-planning-notes{margin-right:auto}
            full-calendar{flex:1;min-height:0;font-size:12px}
            .empty{padding:24px;color:#888}`],
})
export class CalendarPanel {
  store = inject(TripStore); 
  private cal = viewChild(FullCalendarComponent); 
  repo = inject(TripRepo);
  private change = inject(ChangeLoop);
  private dialog = inject(MatDialog);
  private detailsDialog: MatDialogRef<StopDetailsDialog> | null = null;
  private tripStart = computed(() => this.store.activeTrip()?.startDate);
  planningWarnings = computed(() => {
    const warnings = this.store.activeTrip()?.details['plannerWarnings'];
    return Array.isArray(warnings) ? warnings.filter((w): w is string => typeof w === 'string') : [];
  });

  // Stops - calendar events (recomputes when stops, selection or preview change)
  private events = computed(() => {
    const previewing = !!this.store.preview();
    const sel = this.store.selectedStopId();
    return this.store.stops().map(s => ({
      id: s.id,
      title: s.locked ? `🔒 ${s.title}` : s.title,  // Lock icon marks anchors
      start: s.start,
      end: s.end,
      editable: !s.locked && !previewing && !this.store.loading(),
      color: CATEGORY_COLORS[s.category] ?? '#3d5a80',
      className: [s.id === sel ? 'is-selected' : '', previewing ? 'is-preview' : ''].join(' ').trim(),
    }));
  });

  // Shades the hours outside the group's active hours
  private businessHours = computed(() => {
    const h = this.store.groupPrefs()?.merged.activeHours;
    return h ? { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startTime: h.start, endTime: h.end } : false;
  });

  options = computed(() => {
    const t = this.store.activeTrip();
    const days = t ? differenceInCalendarDays(parseISO(t.endDate), parseISO(t.startDate)) + 1 : 3;
    return {
      plugins: [themePlugin, timeGridPlugin, interactionPlugin],
      initialView: 'tripDays',
      views: { tripDays: { type: 'timeGrid', duration: { days: Math.max(1, Math.min(days, 7)) } } },
      initialDate: t?.startDate,
      validRange: t
        ? { start: t.startDate, end: format(addDays(parseISO(t.endDate), 1), 'yyyy-MM-dd') }
        : undefined,
      headerToolbar: { start: 'prev,next', center: 'title', end: '' },
      allDaySlot: false,
      slotMinTime: '06:00:00',
      slotMaxTime: '24:00:00',
      scrollTime: '08:00:00',
      height: '100%',
      editable: true,
      snapDuration: '00:15:00',  // Drags snap to 15-minute steps
      businessHours: this.businessHours(),
      events: this.events(),
      eventClick: (info: any) => this.store.selectedStopId.set(info.event.id),  // Click selects the stop (map should also follow)
      eventDrop: (info: any) => this.onMoved(info), // Dragged to a new time/day
      eventResize: (info: any) => this.onMoved(info), // Duration changed
    } as CalendarOptions;
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.detailsDialog?.close());
    // initialDate is only consumed on mount. A newly selected/generated trip needs an explicit jump.
    effect(() => {
      const startDate = this.tripStart();
      const api = this.cal()?.getApi();
      if (startDate && api) api.gotoDate(startDate);
    });
    // Calendar and map selections share a modal; no details panel consumes calendar height.
    effect(() => {
      const s = this.store.selectedStop();
      const trip = this.store.activeTrip();
      const api = this.cal()?.getApi();
      if (s && api) api.gotoDate(s.start.slice(0, 10));
      untracked(() => {
        if (!s || !trip) { this.detailsDialog?.close(); return; }
        const current = this.detailsDialog?.componentInstance.data;
        if (current?.tripId === trip.id && current.stop.id === s.id) return;
        this.detailsDialog?.close();
        const ref = this.dialog.open<StopDetailsDialog, StopDetailsData>(StopDetailsDialog, {
          data: { tripId: trip.id, startDate: trip.startDate, endDate: trip.endDate, stop: s },
          width: '560px', maxWidth: 'calc(100vw - 32px)', maxHeight: '90vh', autoFocus: 'dialog',
        });
        this.detailsDialog = ref;
        ref.afterClosed().subscribe(() => {
          if (this.detailsDialog !== ref) return;
          this.detailsDialog = null;
          if (this.store.activeTripId() === trip.id && this.store.selectedStopId() === s.id) {
            this.store.selectedStopId.set(null);
          }
        });
      });
    });
  }

  //writes a drag/resize back into the store, recomputing the stop's day number
  private onMoved(info: any) {
    const trip = this.store.activeTrip();
    if (!trip) return;
    const start = toLocal(info.event.start);
    const end = toLocal(info.event.end ?? info.event.start);
    const day = differenceInCalendarDays(parseISO(start.slice(0, 10)), parseISO(trip.startDate)) + 1;
    this.store.updateStop(info.event.id, { start, end, day });
    this.repo.saveActiveStops();
    this.change.push({ // store dragged event information
      stopId: info.event.id,
      from: { start: toLocal(info.oldEvent.start), end: toLocal(info.oldEvent.end ?? info.oldEvent.start) },
      to: { start, end },
    });
  }

}
