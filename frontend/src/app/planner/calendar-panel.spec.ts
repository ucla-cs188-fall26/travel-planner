import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { ChangeLoop } from '../core/change-loop';
import { Stop, Trip } from '../core/models';
import { TripRepo } from '../core/trip-repo';
import { TripStore } from '../core/trip-store';
import { CalendarPanel } from './calendar-panel';

describe('Calendar details modal', () => {
  const stop: Stop = { id: 'lunch', day: 1, title: 'French lunch', start: '2026-11-20T11:00:00',
    end: '2026-11-20T12:00:00', place: { name: 'Cafe', address: 'Paris, France' }, category: 'food', locked: false };
  const trip: Trip = { id: 'trip', name: 'Paris', ownerId: 'user', memberIds: ['user'],
    startDate: '2026-11-20', endDate: '2026-11-20', status: 'planned', details: {},
    anchors: [], overrides: {}, stops: [stop] };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [CalendarPanel], providers: [
      { provide: TripRepo, useValue: { saveActiveStops: vi.fn().mockResolvedValue(undefined) } },
      { provide: ChangeLoop, useValue: { push: vi.fn() } },
    ] });
    // The calendar layout depends on browser measurements; exercise its selection wiring with a real overlay.
    TestBed.overrideComponent(CalendarPanel, { set: { template: '' } });
    const store = TestBed.inject(TripStore);
    store.upsertTrip(structuredClone(trip));
    store.selectTrip(trip.id);
  });

  it('opens details in a separate dialog overlay and clears selection on dismiss', async () => {
    const fixture = TestBed.createComponent(CalendarPanel);
    fixture.detectChanges();
    const click = fixture.componentInstance.options().eventClick as (info: unknown) => void;
    click({ event: { id: stop.id } });
    fixture.detectChanges();
    await fixture.whenStable();
    const dialogs = TestBed.inject(MatDialog);
    expect(dialogs.openDialogs).toHaveLength(1);
    expect(document.querySelector('mat-dialog-container')?.textContent).toContain('French lunch');
    expect(fixture.nativeElement.querySelector('mat-dialog-container')).toBeNull();
    expect(document.querySelector<HTMLInputElement>('mat-dialog-container input[type="time"]')?.value).toBe('11:00');
    // A store update for the same activity must not open another copy of the modal.
    TestBed.inject(TripStore).updateStop(stop.id, { locked: true });
    fixture.detectChanges();
    expect(dialogs.openDialogs).toHaveLength(1);
    const closed = firstValueFrom(dialogs.openDialogs[0].afterClosed());
    dialogs.closeAll();
    await closed;
    expect(TestBed.inject(TripStore).selectedStopId()).toBeNull();
  });

  it('dismisses the details when the active trip changes', async () => {
    const fixture = TestBed.createComponent(CalendarPanel);
    const store = TestBed.inject(TripStore);
    store.selectedStopId.set(stop.id);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(TestBed.inject(MatDialog).openDialogs).toHaveLength(1);
    const closed = firstValueFrom(TestBed.inject(MatDialog).openDialogs[0].afterClosed());
    store.upsertTrip({ ...trip, id: 'other' });
    store.selectTrip('other');
    fixture.detectChanges();
    await fixture.whenStable();
    await closed;
    expect(TestBed.inject(MatDialog).openDialogs).toHaveLength(0);
  });
});
