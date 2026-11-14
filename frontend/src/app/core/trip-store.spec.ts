import { StopSchema, TripSchema } from './models';
import { TripStore } from './trip-store';

describe('TripStore proposal preview', () => {
  const existing = StopSchema.parse({ id: 'old', day: 1, title: 'Existing reservation',
    start: '2026-11-20T10:00:00', end: '2026-11-20T11:00:00', place: { name: 'Museum' } });
  const suggested = { ...existing, id: 'new', title: 'Suggested visit' };
  let store: TripStore;

  beforeEach(() => {
    store = new TripStore();
    store.setTrips([TripSchema.parse({ id: 'trip-1', name: 'Paris', ownerId: 'alice', memberIds: ['alice'],
      startDate: '2026-11-20', endDate: '2026-11-20', stops: [existing] })]);
    store.selectTrip('trip-1');
  });

  it('renders proposed stops while preserving the saved active trip', () => {
    store.showPreview('Try this visit', [suggested], [], 'solver');
    expect(store.stops()).toEqual([suggested]);
    expect(store.activeTrip()?.stops).toEqual([existing]);
    expect(store.preview()?.tripId).toBe('trip-1');
    expect(store.preview()?.baseStops).toBe(JSON.stringify([existing]));
  });

  it('discards a preview without changing the current saved schedule', () => {
    store.showPreview('Try this visit', [suggested], [], 'solver');
    const remote = { ...existing, title: 'Updated by another member' };
    store.patchActiveTrip({ stops: [remote] });
    store.revertPreview();
    expect(store.preview()).toBeNull();
    expect(store.stops()).toEqual([remote]);
    expect(store.activeTrip()?.stops).toEqual([remote]);
  });

  it('clears the old trip preview on trip selection', () => {
    store.showPreview('Try this visit', [suggested], [], 'solver');
    store.selectTrip('trip-2');
    expect(store.preview()).toBeNull();
    expect(store.stops()).toEqual([]);
    expect(store.trips()[0].stops).toEqual([existing]);
  });
});
