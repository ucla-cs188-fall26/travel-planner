import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { ChangeBanner } from './change-banner';
import { TripRepo } from '../core/trip-repo';
import { TripStore } from '../core/trip-store';

describe('Compact schedule warnings', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [ChangeBanner], providers: [
    { provide: TripRepo, useValue: { saveActiveStops: vi.fn().mockResolvedValue(undefined) } },
  ] }));

  it('keeps long warnings out of the banner and opens them in a dialog on click', async () => {
    const store = TestBed.inject(TripStore);
    const warnings = ['Opening hours require confirmation.', 'The travel buffer is estimated.', 'Opening hours require confirmation.'];
    store.showPreview('Adjusted the remaining activities to fit your edited time.', [], warnings);
    const fixture = TestBed.createComponent(ChangeBanner);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain(warnings[0]);
    expect(fixture.nativeElement.textContent).not.toContain('Adjusted the remaining');
    const button = fixture.nativeElement.querySelector('app-planning-notes button') as HTMLButtonElement;
    expect(button.textContent).toContain('(2)');
    button.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const modal = document.querySelector('mat-dialog-container');
    expect(modal?.textContent).toContain(warnings[0]);
    expect(modal?.textContent).toContain(warnings[1]);
    expect(modal?.textContent).toContain('Adjusted the remaining activities');
    const dialogs = TestBed.inject(MatDialog);
    const closed = firstValueFrom(dialogs.openDialogs[0].afterClosed());
    dialogs.closeAll();
    await closed;
  });

  it('continues to show actual errors inline with the recovery controls', () => {
    const store = TestBed.inject(TripStore);
    store.changeError.set('The new time conflicts with the locked museum visit.');
    store.changeStatus.set('error');
    const fixture = TestBed.createComponent(ChangeBanner);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('conflicts with the locked museum');
    expect(fixture.nativeElement.textContent).toContain('Undo Change');
    expect(fixture.nativeElement.textContent).toContain('Keep My Change');
    expect(fixture.nativeElement.querySelector('app-planning-notes')).toBeNull();
  });
});
