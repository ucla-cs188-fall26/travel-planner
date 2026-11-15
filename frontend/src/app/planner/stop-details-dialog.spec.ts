import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { ChangeLoop } from '../core/change-loop';
import { Stop, Trip } from '../core/models';
import { TripRepo } from '../core/trip-repo';
import { TripStore } from '../core/trip-store';
import { StopDetailsDialog } from './stop-details-dialog';

describe('Activity details and time editing', () => {
  const stop: Stop = { id: 'lunch', day: 1, title: 'French lunch', start: '2026-11-20T11:00:00',
    end: '2026-11-20T12:00:00', place: { name: 'Cafe', address: 'Paris, France' },
    category: 'food', locked: false, priceRange: '~USD 30/person', notes: 'Prices are estimates.' };
  const trip: Trip = { id: 'trip', name: 'Paris', ownerId: 'user', memberIds: ['user'],
    startDate: '2026-11-20', endDate: '2026-11-22', status: 'planned', details: {},
    anchors: [], overrides: {}, stops: [stop] };
  let store: TripStore;
  let repo: { saveActiveStops: ReturnType<typeof vi.fn> };
  let change: { push: ReturnType<typeof vi.fn> };
  let ref: { close: ReturnType<typeof vi.fn>; disableClose: boolean };

  beforeEach(() => {
    repo = { saveActiveStops: vi.fn().mockResolvedValue(undefined) };
    change = { push: vi.fn() };
    ref = { close: vi.fn(), disableClose: false };
    TestBed.configureTestingModule({ imports: [StopDetailsDialog], providers: [
      { provide: MAT_DIALOG_DATA, useValue: { tripId: trip.id, startDate: trip.startDate, endDate: trip.endDate, stop } },
      { provide: MatDialogRef, useValue: ref },
      { provide: TripRepo, useValue: repo }, { provide: ChangeLoop, useValue: change },
    ] });
    store = TestBed.inject(TripStore);
    store.upsertTrip(structuredClone(trip));
    store.selectTrip(trip.id);
  });

  it('shows activity information with labeled date and time inputs', () => {
    const fixture = TestBed.createComponent(StopDetailsDialog);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('French lunch');
    expect(el.textContent).toContain('Paris, France');
    expect(el.textContent).toContain('Prices are estimates.');
    expect(el.querySelector<HTMLInputElement>('input[type="date"]')?.value).toBe('2026-11-20');
    expect([...el.querySelectorAll<HTMLInputElement>('input[type="time"]')].map(i => i.value)).toEqual(['11:00', '12:00']);
  });

  it('saves destination-local times, updates the day and checks the change with the solver', async () => {
    const component = TestBed.createComponent(StopDetailsDialog).componentInstance;
    component.form.setValue({ date: '2026-11-21', startTime: '12:30', endTime: '14:00' });
    await component.save();
    expect(store.stops()[0]).toMatchObject({ start: '2026-11-21T12:30:00', end: '2026-11-21T14:00:00', day: 2 });
    expect(repo.saveActiveStops).toHaveBeenCalledTimes(1);
    expect(change.push).toHaveBeenCalledWith({ stopId: stop.id,
      from: { start: stop.start, end: stop.end }, to: { start: '2026-11-21T12:30:00', end: '2026-11-21T14:00:00' } });
    expect(ref.close).toHaveBeenCalledTimes(1);
    store.revertPreview();
    expect(store.stops()[0].start).toBe(stop.start);
  });

  it.each([
    ['2026-11-19', '11:00', '12:00'], ['2026-11-23', '11:00', '12:00'],
    ['2026-02-30', '11:00', '12:00'], ['2026-11-20', '12:00', '11:00'],
    ['2026-11-20', '11:00', '11:10'], ['2026-11-20', '08:00', '21:00'],
  ])('rejects invalid date/duration %s %s–%s', async (date, startTime, endTime) => {
    const component = TestBed.createComponent(StopDetailsDialog).componentInstance;
    component.form.setValue({ date, startTime, endTime });
    await component.save();
    expect(component.form.invalid).toBe(true);
    expect(repo.saveActiveStops).not.toHaveBeenCalled();
    expect(change.push).not.toHaveBeenCalled();
  });

  it('requires unlocking before time edits and persists the unlock', async () => {
    store.updateStop(stop.id, { locked: true });
    store.clearEditSnapshot();
    const component = TestBed.createComponent(StopDetailsDialog).componentInstance;
    component.form.patchValue({ startTime: '12:00', endTime: '13:00' });
    await component.save();
    expect(change.push).not.toHaveBeenCalled();
    await component.toggleLock();
    expect(store.stops()[0].locked).toBe(false);
    await component.save();
    expect(change.push).toHaveBeenCalledTimes(1);
  });

  it('restores the original times on persistence failure and leaves the dialog open', async () => {
    repo.saveActiveStops.mockRejectedValueOnce(new Error('Save failed'));
    const component = TestBed.createComponent(StopDetailsDialog).componentInstance;
    component.form.patchValue({ startTime: '12:00', endTime: '13:30' });
    await component.save();
    expect(store.stops()[0]).toEqual(stop);
    expect(component.error()).toBe('Save failed');
    expect(ref.close).not.toHaveBeenCalled();
    expect(change.push).not.toHaveBeenCalled();
  });

  it('does not modify an itinerary preview', async () => {
    store.showPreview('Review changes', [stop], []);
    const component = TestBed.createComponent(StopDetailsDialog).componentInstance;
    component.form.patchValue({ startTime: '12:00', endTime: '13:30' });
    await component.save();
    await component.toggleLock();
    expect(repo.saveActiveStops).not.toHaveBeenCalled();
  });
});
