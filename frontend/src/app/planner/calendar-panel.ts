import { Component, computed, effect, inject, viewChild } from '@angular/core';
import { FullCalendarModule, FullCalendarComponent, CalendarOptions } from '@fullcalendar/angular';
import themePlugin from '@fullcalendar/angular/themes/classic';
import timeGridPlugin from '@fullcalendar/angular/timegrid';
import interactionPlugin from '@fullcalendar/angular/interaction';
import { format, addDays, parseISO, differenceInCalendarDays } from 'date-fns';
import { MatButtonModule } from '@angular/material/button';
import { TripStore } from '../core/trip-store';
import { TripRepo } from '../core/trip-repo';
import { ChangeLoop } from '../core/change-loop'

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
  imports: [FullCalendarModule, MatButtonModule],
  template: `
    <div class="bar">  <!-- Small toolbar above the calendar -->
      <button mat-button (click)="store.undo(); repo.saveActiveStops()">Undo</button>
    </div>
    @if (store.activeTrip()) {
      <full-calendar [options]="options()" /> 
    } @else {
      <div class="empty">Select or create a trip</div>
    }`,
  styles: [`:host{display:flex;flex-direction:column;flex:1;min-height:0}
            .bar{display:flex;justify-content:flex-end;padding:2px 6px}
            full-calendar{flex:1;min-height:0;font-size:12px}
            .empty{padding:24px;color:#888}`],
})
export class CalendarPanel {
  store = inject(TripStore); 
  private cal = viewChild(FullCalendarComponent); 
  repo = inject(TripRepo);
  private change = inject(ChangeLoop);

  // Stops - calendar events (recomputes when stops, selection or preview change)
  private events = computed(() => {
    const previewing = !!this.store.preview();
    const sel = this.store.selectedStopId();
    return this.store.stops().map(s => ({
      id: s.id,
      title: s.locked ? `🔒 ${s.title}` : s.title,  // Lock icon marks anchors
      start: s.start,
      end: s.end,
      editable: !s.locked && !previewing,  // Anchors and previews can't be dragged
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
    //when a stop is selected from the map, jump the calendar to that stop's day
    effect(() => {
      const s = this.store.selectedStop();
      const api = this.cal()?.getApi();
      if (s && api) api.gotoDate(s.start.slice(0, 10));
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