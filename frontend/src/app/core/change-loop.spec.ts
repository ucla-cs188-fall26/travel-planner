import { TestBed } from '@angular/core/testing';
import { ChangeLoop } from './change-loop';
import { ConstraintPlanner } from './constraint-planner';
import { EditDiff, TripSchema } from './models';
import { TripStore } from './trip-store';

describe('ChangeLoop proposal requests', () => {
  let store: TripStore;
  let loop: ChangeLoop;
  let suggest: ReturnType<typeof vi.fn>;
  const diff = (stopId: string, hour: string): EditDiff => ({
    stopId,
    from: { start: '2026-11-20T10:00:00', end: '2026-11-20T11:00:00' },
    to: { start: `2026-11-20T${hour}:00:00`, end: `2026-11-20T${hour}:30:00` },
  });

  beforeEach(() => {
    vi.useFakeTimers();
    store = new TripStore();
    store.setTrips(['trip-1', 'trip-2'].map(id => TripSchema.parse({ id, name: id,
      ownerId: 'alice', memberIds: ['alice'], startDate: '2026-11-20', endDate: '2026-11-20' })));
    store.selectTrip('trip-1');
    suggest = vi.fn().mockResolvedValue(undefined);
    TestBed.configureTestingModule({ providers: [
      ChangeLoop, { provide: TripStore, useValue: store },
      { provide: ConstraintPlanner, useValue: { suggest } },
    ] });
    loop = TestBed.inject(ChangeLoop);
  });

  afterEach(() => vi.useRealTimers());

  it('debounces gestures and requests only the latest edit for each stop', () => {
    const original = structuredClone(store.trips());
    loop.push(diff('museum', '12'));
    vi.advanceTimersByTime(500);
    loop.push(diff('museum', '13'));
    loop.push(diff('lunch', '14'));
    vi.advanceTimersByTime(899);
    expect(suggest).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(suggest).toHaveBeenCalledExactlyOnceWith([diff('museum', '13'), diff('lunch', '14')]);
    expect(store.trips()).toEqual(original);
    expect(store.preview()).toBeNull();
  });

  it('discards queued edits belonging to a trip that is no longer open', () => {
    loop.push(diff('museum', '12'));
    store.selectTrip('trip-2');
    vi.advanceTimersByTime(900);
    expect(suggest).not.toHaveBeenCalled();
  });
});
