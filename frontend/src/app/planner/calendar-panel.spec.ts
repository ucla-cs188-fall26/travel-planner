import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ChangeLoop } from '../core/change-loop';
import { ConstraintPlanner } from '../core/constraint-planner';
import { TripSchema } from '../core/models';
import { TripRepo } from '../core/trip-repo';
import { TripStore } from '../core/trip-store';
import { CalendarPanel } from './calendar-panel';

describe('Calendar proposal gestures', () => {
  let panel: CalendarPanel;
  let store: TripStore;
  let push: ReturnType<typeof vi.fn>;
  let save: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = new TripStore();
    store.setTrips([TripSchema.parse({ id: 'trip-1', name: 'Paris', ownerId: 'alice', memberIds: ['alice'],
      startDate: '2026-11-20', endDate: '2026-11-20', stops: [{ id: 'museum', day: 1, title: 'Museum',
        start: '2026-11-20T10:00:00', end: '2026-11-20T11:00:00', place: { name: 'Museum' } }] })]);
    store.selectTrip('trip-1');
    push = vi.fn();
    save = vi.fn();
    TestBed.configureTestingModule({
      imports: [CalendarPanel],
      providers: [
        { provide: TripStore, useValue: store },
        { provide: TripRepo, useValue: { saveActiveStops: save } },
        { provide: ChangeLoop, useValue: { push } },
        { provide: ConstraintPlanner, useValue: { busy: signal(false), applying: signal(false), dismiss: vi.fn() } },
      ],
    }).overrideComponent(CalendarPanel, { set: { template: '', imports: [] } });
    panel = TestBed.createComponent(CalendarPanel).componentInstance;
    TestBed.tick();
  });

  it.each(['eventDrop', 'eventResize'] as const)('%s restores the calendar event and only requests a proposal', event => {
    const original = structuredClone(store.activeTrip()!.stops);
    const order: string[] = [];
    const info = {
      event: { id: 'museum', start: '2026-11-20T12:00:00', end: '2026-11-20T13:00:00' },
      oldEvent: { start: '2026-11-20T10:00:00', end: '2026-11-20T11:00:00' },
      revert: vi.fn(() => {
        order.push('revert');
        // FullCalendar may restore the event synchronously; capture the requested time first.
        info.event.start = info.oldEvent.start;
        info.event.end = info.oldEvent.end;
      }),
    };
    push.mockImplementation(() => order.push('request'));
    const callback = panel.options()[event] as (event: unknown) => void;
    callback(info);
    expect(order).toEqual(['revert', 'request']);
    expect(push).toHaveBeenCalledWith({ stopId: 'museum',
      from: { start: '2026-11-20T10:00:00', end: '2026-11-20T11:00:00' },
      to: { start: '2026-11-20T12:00:00', end: '2026-11-20T13:00:00' } });
    expect(save).not.toHaveBeenCalled();
    expect(store.activeTrip()?.stops).toEqual(original);
    expect(store.preview()).toBeNull();
  });
});
