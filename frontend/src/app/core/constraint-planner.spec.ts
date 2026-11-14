import { HttpClient } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Firestore, runTransaction } from '@angular/fire/firestore';
import { Subject } from 'rxjs';
import { AuthService } from './auth';
import { MemberConstraintSession, SolverResponse } from './constraint-models';
import { ConstraintPlanner } from './constraint-planner';
import { ConstraintSessionService } from './constraint-session';
import { TripSchema } from './models';
import { TripStore } from './trip-store';

vi.mock('@angular/fire/firestore', async importOriginal => {
  const actual = await importOriginal<typeof import('@angular/fire/firestore')>();
  // Object.assign avoids an esbuild spread helper imported after Vitest hoists this factory.
  return Object.assign({}, actual, {
    doc: vi.fn((_db: unknown, ...parts: string[]) => ({ path: parts.join('/') })),
    runTransaction: vi.fn(),
  });
});

describe('ConstraintPlanner proposal safety', () => {
  const existing = { id: 'existing', day: 1, title: 'Existing visit',
    start: '2026-11-20T10:00:00', end: '2026-11-20T11:00:00', place: { name: 'Museum' },
    category: 'sight' as const, locked: false };
  const proposed = { ...existing, id: 'proposal-stop', title: 'Suggested visit' };
  const trip = TripSchema.parse({ id: 'trip-1', name: 'Paris', ownerId: 'alice', memberIds: ['alice'],
    startDate: '2026-11-20', endDate: '2026-11-20', stops: [existing] });
  const session: MemberConstraintSession = {
    uid: 'alice', schemaVersion: 1, revision: 1, confirmed: true,
    answers: [], answerHistory: [], constraints: [], updatedAt: 1,
  };
  let planner: ConstraintPlanner;
  let store: TripStore;
  let responses: Subject<unknown>[];
  let post: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;
  let live: Map<string, unknown>;
  let sessions: ReturnType<typeof signal<MemberConstraintSession[]>>;
  let allConfirmed: ReturnType<typeof signal<boolean>>;
  let reviewDirty: ReturnType<typeof signal<boolean>>;
  let user: ReturnType<typeof signal<{ uid: string } | null>>;

  beforeEach(() => {
    vi.stubGlobal('crypto', { subtle: { digest: vi.fn().mockResolvedValue(new Uint8Array(32).buffer) } });
    vi.mocked(runTransaction).mockReset();
    store = new TripStore();
    store.setTrips([structuredClone(trip)]);
    store.selectTrip(trip.id);
    responses = [];
    post = vi.fn(() => {
      const response = new Subject<unknown>();
      responses.push(response);
      return response;
    });
    update = vi.fn();
    live = new Map<string, unknown>([
      ['trips/trip-1', structuredClone(trip)],
      ['trips/trip-1/constraintSessions/alice', structuredClone(session)],
    ]);
    vi.mocked(runTransaction).mockImplementation(async (_db, callback) => callback({
      get: vi.fn(async (ref: { path: string }) => ({
        id: ref.path.split('/').at(-1), exists: () => live.has(ref.path), data: () => structuredClone(live.get(ref.path)),
      })),
      update,
    } as never));
    sessions = signal([structuredClone(session)]);
    allConfirmed = signal(true);
    reviewDirty = signal(false);
    user = signal<{ uid: string } | null>({ uid: 'alice' });
    TestBed.configureTestingModule({ providers: [
      ConstraintPlanner,
      { provide: HttpClient, useValue: { post } },
      { provide: Firestore, useValue: {} },
      { provide: AuthService, useValue: { user } },
      { provide: TripStore, useValue: store },
      { provide: ConstraintSessionService, useValue: {
        catalog: signal({ id: 'paris-v1' }), sessions, allConfirmed, reviewDirty,
      } },
    ] });
    planner = TestBed.inject(ConstraintPlanner);
    TestBed.tick();
  });

  afterEach(() => vi.unstubAllGlobals());

  function responseFor(index: number): SolverResponse {
    const input = post.mock.calls[index][1] as { inputVersion: string };
    return { status: 'sat', conflicts: [], explanations: [], proposal: {
      id: `proposal-${index}`, tripId: trip.id, inputVersion: input.inputVersion, catalogId: 'paris-v1',
      summary: 'A proposed schedule', stops: [proposed], warnings: [], memberScores: [{ uid: 'alice', score: 1 }],
    } };
  }

  async function readyProposal() {
    const pending = planner.suggest();
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    responses[0].next(responseFor(0));
    responses[0].complete();
    await pending;
  }

  it('only previews a successful solve; it never writes or changes the saved schedule', async () => {
    await readyProposal();
    expect(store.preview()?.source).toBe('solver');
    expect(store.stops()).toEqual([proposed]);
    expect(store.activeTrip()?.stops).toEqual([existing]);
    expect(vi.mocked(runTransaction)).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('does not request a proposal before all members confirm their conditions', async () => {
    allConfirmed.set(false);
    await planner.suggest();
    expect(post).not.toHaveBeenCalled();
    expect(planner.error()).toContain('Every member');
    expect(store.activeTrip()?.stops).toEqual([existing]);
  });

  it('ignores a late response after the saved schedule changes', async () => {
    const pending = planner.suggest();
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const changed = { ...existing, title: 'Changed by another member' };
    store.patchActiveTrip({ stops: [changed] });
    TestBed.tick();
    responses[0].next(responseFor(0));
    responses[0].complete();
    await pending;
    expect(planner.result()).toBeNull();
    expect(store.preview()).toBeNull();
    expect(store.activeTrip()?.stops).toEqual([changed]);
    expect(vi.mocked(runTransaction)).not.toHaveBeenCalled();
  });

  it('invalidates an existing preview when a member edits their review', async () => {
    await readyProposal();
    reviewDirty.set(true);
    TestBed.tick();
    await planner.apply();
    expect(planner.proposal()).toBeNull();
    expect(store.preview()).toBeNull();
    expect(vi.mocked(runTransaction)).not.toHaveBeenCalled();
    expect(store.activeTrip()?.stops).toEqual([existing]);
  });

  it('invalidates a proposal while a member answer is being saved and confirmation is unavailable', async () => {
    await readyProposal();
    allConfirmed.set(false);
    TestBed.tick();
    await planner.apply();
    expect(planner.proposal()).toBeNull();
    expect(store.preview()).toBeNull();
    expect(vi.mocked(runTransaction)).not.toHaveBeenCalled();
    expect(store.activeTrip()?.stops).toEqual([existing]);
  });

  it('clears a preview when the active trip disappears from the subscription', async () => {
    await readyProposal();
    store.setTrips([]);
    TestBed.tick();
    expect(planner.proposal()).toBeNull();
    expect(store.preview()).toBeNull();
    expect(store.stops()).toEqual([]);
    expect(vi.mocked(runTransaction)).not.toHaveBeenCalled();
  });

  it('rejects a response carrying a different input version', async () => {
    const pending = planner.suggest();
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const invalid = responseFor(0);
    invalid.proposal!.inputVersion = 'obsolete';
    responses[0].next(invalid);
    responses[0].complete();
    await pending;
    expect(planner.result()).toBeNull();
    expect(planner.error()).toContain('does not match');
    expect(store.preview()).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it.each(['trip', 'member'] as const)('rejects acceptance if the live %s document changed before subscriptions catch up', async kind => {
    await readyProposal();
    if (kind === 'trip') {
      live.set('trips/trip-1', { ...trip, stops: [{ ...existing, title: 'New live reservation' }] });
    } else {
      live.set('trips/trip-1/constraintSessions/alice', { ...session, revision: 2, updatedAt: 2 });
    }
    await planner.apply();
    expect(vi.mocked(runTransaction)).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(planner.error()).toContain('have changed');
    expect(store.activeTrip()?.stops).toEqual([existing]);
  });

  it('preserves the saved schedule and preview when the acceptance transaction fails', async () => {
    await readyProposal();
    vi.mocked(runTransaction).mockRejectedValueOnce(new Error('Permission denied'));
    await planner.apply();
    expect(planner.error()).toBe('Permission denied');
    expect(planner.applying()).toBe(false);
    expect(store.activeTrip()?.stops).toEqual([existing]);
    expect(store.preview()?.stops).toEqual([proposed]);
    expect(update).not.toHaveBeenCalled();
  });

  it('writes only after explicit acceptance and waits for the Firestore subscription to update local stops', async () => {
    await readyProposal();
    await planner.apply();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ path: 'trips/trip-1' }, expect.objectContaining({
      stops: [proposed], status: 'planned',
      acceptedProposal: expect.objectContaining({ id: 'proposal-0', acceptedBy: 'alice', catalogId: 'paris-v1' }),
    }));
    expect(planner.error()).toBeNull();
    expect(store.preview()).toBeNull();
    expect(store.activeTrip()?.stops).toEqual([existing]);
  });
});
