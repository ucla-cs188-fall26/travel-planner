import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ChangeLoop } from './change-loop';
import { Api } from './api';
import { MapsLoader } from './maps-loader';
import { TripStore } from './trip-store';
import { ChangeResponse, Stop, Trip } from './models';

describe('Calendar replanning', () => {
  afterEach(() => vi.useRealTimers());

  it('batches repeated moves and displays the solver preview without waiting for Maps', () => {
    vi.useFakeTimers();
    const stop: Stop = { id: 'lunch', title: 'Lunch', day: 1, start: '2026-11-20T14:00:00',
      end: '2026-11-20T15:00:00', place: { name: 'Cafe', placeId: 'existing', lat: 48, lng: 2 },
      category: 'food', locked: false };
    const trip: Trip = { id: 'trip', name: 'Paris', ownerId: 'user', memberIds: ['user'],
      startDate: '2026-11-20', endDate: '2026-11-20', status: 'planned', details: {},
      anchors: [], overrides: {}, stops: [stop] };
    const change = vi.fn().mockReturnValue(of({ summary: 'Replanned.',
      changes: [{ ...stop, place: { name: 'Cafe' } }], warnings: [] } satisfies ChangeResponse));
    TestBed.configureTestingModule({ providers: [{ provide: Api, useValue: { change } },
      { provide: MapsLoader, useValue: { resolveStops: () => new Promise(() => {}) } }] });
    const store = TestBed.inject(TripStore);
    store.upsertTrip(trip);
    store.selectTrip(trip.id);
    const loop = TestBed.inject(ChangeLoop);
    const initial = { start: '2026-11-20T12:00:00', end: '2026-11-20T13:00:00' };
    const midway = { start: '2026-11-20T13:00:00', end: '2026-11-20T14:00:00' };
    const final = { start: stop.start, end: stop.end };
    loop.push({ stopId: stop.id, from: initial, to: midway });
    loop.push({ stopId: stop.id, from: midway, to: final });
    vi.advanceTimersByTime(901);
    expect(change).toHaveBeenCalledTimes(1);
    expect(change.mock.calls[0][0].diff).toEqual([{ stopId: stop.id, from: initial, to: final }]);
    expect(store.preview()?.stops[0].place.placeId).toBe('existing');
    expect(store.preview()?.summary).toBe('Replanned.');
    expect(store.changeStatus()).toBe('idle');
  });

  it('does not send a pending edit for a different trip after switching trips', () => {
    vi.useFakeTimers();
    const change = vi.fn();
    TestBed.configureTestingModule({ providers: [{ provide: Api, useValue: { change } },
      { provide: MapsLoader, useValue: {} }] });
    const store = TestBed.inject(TripStore);
    const trip: Trip = { id: 'first', name: 'Paris', ownerId: 'user', memberIds: [],
      startDate: '2026-11-20', endDate: '2026-11-20', status: 'planned', details: {},
      anchors: [], overrides: {}, stops: [] };
    store.upsertTrip(trip);
    store.selectTrip(trip.id);
    TestBed.inject(ChangeLoop).push({ stopId: 'lunch',
      from: { start: '2026-11-20T12:00:00', end: '2026-11-20T13:00:00' },
      to: { start: '2026-11-20T13:00:00', end: '2026-11-20T14:00:00' } });
    expect(store.changeStatus()).toBe('pending');
    store.upsertTrip({ ...trip, id: 'second' });
    store.selectTrip('second');
    vi.advanceTimersByTime(901);
    expect(change).not.toHaveBeenCalled();
    expect(store.changeStatus()).toBe('idle');
  });
});
