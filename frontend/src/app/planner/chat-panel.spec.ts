import { TestBed } from '@angular/core/testing';
import { provideMarkdown } from 'ngx-markdown';
import { ChatPanel } from './chat-panel';
import { Api } from '../core/api';
import { MapsLoader } from '../core/maps-loader';
import { TripRepo } from '../core/trip-repo';
import { TripStore } from '../core/trip-store';
import { ChatResponse, Stop, Trip } from '../core/models';
import { CalendarPanel } from './calendar-panel';
import { ChangeLoop } from '../core/change-loop';

describe('Planner schedule integration', () => {
  // jsdom does not implement scrolling; the real chat scrolls when its DOM is rendered.
  beforeEach(() => Object.defineProperty(HTMLElement.prototype, 'scrollTo', { value: vi.fn(), configurable: true }));
  afterEach(() => Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo'));
  const stop: Stop = { id: 'museum', day: 1, title: 'Museum', start: '2026-11-20T10:00:00',
    end: '2026-11-20T11:00:00', place: { name: 'Museum' }, category: 'sight', locked: true };
  const trip: Trip = { id: 'trip', name: 'Paris', ownerId: 'user', memberIds: ['user'],
    startDate: '2026-11-20', endDate: '2026-11-20', status: 'gathering',
    details: { destination: 'Paris' }, anchors: [], overrides: {}, stops: [] };
  let store: TripStore;
  let api: { chat: ReturnType<typeof vi.fn> };
  let repo: { updateTrip: ReturnType<typeof vi.fn>; saveMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    api = { chat: vi.fn() };
    repo = { updateTrip: vi.fn().mockResolvedValue(undefined), saveMessage: vi.fn().mockResolvedValue(undefined) };
    TestBed.configureTestingModule({ imports: [ChatPanel], providers: [provideMarkdown(),
      { provide: Api, useValue: api }, { provide: TripRepo, useValue: repo },
      { provide: MapsLoader, useValue: { resolveStops: () => new Promise(() => {}) } },
      { provide: ChangeLoop, useValue: { push: vi.fn() } },
    ] });
    store = TestBed.inject(TripStore);
    store.upsertTrip(structuredClone(trip));
    store.selectTrip(trip.id);
  });

  it('renders solver stops and saves them before Maps finishes', async () => {
    api.chat.mockResolvedValue({ status: 'ready', reply: 'Plan ready.', itinerary: [stop],
      extracted: { plannerConstraints: { version: 1 } }, warnings: ['Estimated times.'] } satisfies ChatResponse);
    const component = TestBed.createComponent(ChatPanel).componentInstance;
    await component.send('Please plan', { pace: 'relaxed' });
    expect(api.chat.mock.calls[0][0].trip.details.pace).toBe('relaxed');
    expect(store.stops()).toEqual([stop]);
    expect(store.activeTrip()?.status).toBe('planned');
    expect(store.activeTrip()?.details['plannerWarnings']).toEqual(['Estimated times.']);
    expect(repo.updateTrip).toHaveBeenCalledWith('trip', expect.objectContaining({ stops: [stop] }));
    expect(store.loading()).toBe(false);
    const calendar = TestBed.createComponent(CalendarPanel).componentInstance;
    expect(calendar.options().events).toEqual([expect.objectContaining({
      id: stop.id, title: '🔒 Museum', start: stop.start, end: stop.end, editable: false,
    })]);
  });

  it('retains the previous schedule when constraints conflict and shows the follow-up', async () => {
    store.patchActiveTrip({ stops: [stop], status: 'planned' });
    api.chat.mockResolvedValue({ status: 'gathering', reply: 'The budget conflicts with a required visit.',
      extracted: {}, warnings: [], question: { id: 'conflict', field: 'planningClarification',
        type: 'text', prompt: 'Which requirement can change?' } } satisfies ChatResponse);
    await TestBed.createComponent(ChatPanel).componentInstance.send('Lower the budget');
    expect(store.stops()).toEqual([stop]);
    expect(store.pendingQuestion()?.id).toBe('conflict');
    expect(store.messages().at(-1)?.text).toContain('budget conflicts');
  });

  it('offers the first itinerary without requiring a typed planning prompt', async () => {
    api.chat.mockResolvedValue({ status: 'ready', reply: 'Ready.', itinerary: [stop], extracted: {}, warnings: [] });
    const fixture = TestBed.createComponent(ChatPanel);
    fixture.detectChanges();
    const button = [...fixture.nativeElement.querySelectorAll('button')].find((b: any) =>
      b.textContent.includes('Suggest first itinerary')) as HTMLButtonElement;
    expect(button).toBeDefined();
    fixture.componentInstance.draft = 'Include French food.';
    button.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(api.chat).toHaveBeenCalledTimes(1);
    expect(api.chat.mock.calls[0][0]).toMatchObject({ trip: expect.objectContaining({ id: trip.id }) });
    expect(api.chat.mock.calls[0][0].message).toContain('before creating the schedule');
    expect(api.chat.mock.calls[0][0].message).toContain('Include French food.');
    expect(fixture.nativeElement.querySelector('.first-plan')).toBeNull();
  });

  it('does not offer or send an initial proposal when a plan already exists', async () => {
    store.patchActiveTrip({ stops: [stop], status: 'planned' });
    const fixture = TestBed.createComponent(ChatPanel);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.first-plan')).toBeNull();
    await fixture.componentInstance.suggestItinerary();
    expect(api.chat).not.toHaveBeenCalled();
  });

  it('prevents duplicate proposal requests while planning', async () => {
    api.chat.mockReturnValue(new Promise(() => {}));
    const fixture = TestBed.createComponent(ChatPanel);
    fixture.detectChanges();
    void fixture.componentInstance.suggestItinerary();
    void fixture.componentInstance.suggestItinerary();
    fixture.detectChanges();
    expect(api.chat).toHaveBeenCalledTimes(1);
    const button = fixture.nativeElement.querySelector('.first-plan button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('keeps an in-flight response attached to its original trip', async () => {
    let complete!: (response: ChatResponse) => void;
    api.chat.mockReturnValue(new Promise<ChatResponse>(resolve => { complete = resolve; }));
    const component = TestBed.createComponent(ChatPanel).componentInstance;
    const pending = component.send('Plan');
    store.upsertTrip({ ...trip, id: 'other' });
    store.selectTrip('other');
    complete({ status: 'ready', reply: 'Ready.', itinerary: [stop], extracted: {}, warnings: [] });
    await pending;
    expect(store.activeTrip()?.stops).toEqual([]);
    expect(store.trips().find(t => t.id === 'trip')?.stops).toEqual([stop]);
    expect(store.messages().some(m => m.role === 'assistant')).toBe(false);
  });

  it('shows place choices before scheduling and sends only the user-approved places', async () => {
    const suggestion = { id: 'park', title: 'Garden walk', place: { name: 'Garden' },
      reason: 'A quiet garden near your must-do museum.', durationMinutes: 60, costCents: 0 };
    const park: Stop = { ...stop, id: 'park', title: 'Garden walk', locked: false,
      start: '2026-11-20T12:00:00', end: '2026-11-20T13:00:00' };
    api.chat.mockResolvedValueOnce({ status: 'gathering', reply: 'Choose another place.', warnings: [],
      extracted: { pendingProposal: { id: 'proposal' } }, suggestions: [suggestion], proposalId: 'proposal', canSkipSuggestions: true });
    api.chat.mockResolvedValueOnce({ status: 'ready', reply: 'Plan ready.', warnings: [],
      extracted: { pendingProposal: null, acceptedSuggestionIds: ['park'] }, itinerary: [stop, park] });
    const fixture = TestBed.createComponent(ChatPanel);
    await fixture.componentInstance.suggestItinerary();
    fixture.detectChanges();
    expect(store.stops()).toEqual([]);
    expect(fixture.nativeElement.querySelector('.first-plan')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Garden walk');
    const checkbox = fixture.nativeElement.querySelector('app-place-suggestions input[type="checkbox"]') as HTMLInputElement;
    checkbox.click();
    fixture.detectChanges();
    const build = [...fixture.nativeElement.querySelectorAll('button')].find((b: any) =>
      b.textContent.includes('Build with selected places')) as HTMLButtonElement;
    expect(build.disabled).toBe(false);
    build.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(api.chat.mock.calls[1][0].suggestionDecision).toEqual({ proposalId: 'proposal', action: 'accept', acceptedIds: ['park'] });
    expect(store.stops().map(s => s.id)).toEqual(['museum', 'park']);
    expect(store.activeTrip()?.details['pendingProposal']).toBeNull();
    expect(checkbox.disabled).toBe(true);
    expect(repo.saveMessage).toHaveBeenCalledWith('trip', expect.objectContaining({ suggestions: [suggestion], proposalId: 'proposal' }));
  });

  it('does not accept a superseded place proposal', async () => {
    store.patchActiveTrip({ details: { ...trip.details, pendingProposal: { id: 'new' } } });
    const component = TestBed.createComponent(ChatPanel).componentInstance;
    await component.decideSuggestions({ id: 'old-message', role: 'assistant', text: 'Old choices',
      createdAt: 1, proposalId: 'old', suggestions: [], canSkipSuggestions: true }, []);
    expect(api.chat).not.toHaveBeenCalled();
  });
});
