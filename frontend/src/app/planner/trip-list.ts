import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatDialog } from '@angular/material/dialog';
import { TripStore } from '../core/trip-store';
import { TripRepo } from '../core/trip-repo';
import { Api } from '../core/api';
import { MapsLoader } from '../core/maps-loader';
import { NewTripDialog, NewTripResult } from './new-trip-dialog';

// Left pane: trips from Firestore, with new, rename, remove, and load demo features
@Component({
  selector: 'app-trip-list',
  imports: [DatePipe, MatButtonModule, MatIconModule, MatMenuModule],
  template: `
    <div class="head">
      <button mat-flat-button (click)="newTrip()"><mat-icon>add</mat-icon> New Trip</button>
      <button mat-button (click)="loadDemo()" [disabled]="busy()">Load Demo Trip</button> <!-- Copies the mock fixture into Firestore -->
    </div>
    <ul class="list">
      @for (t of store.trips(); track t.id) {
        <li [class.active]="t.id === store.activeTripId()" (click)="open(t.id)">
          @if (editingId() === t.id) {
            <input #name [value]="t.name" (click)="$event.stopPropagation()"
                   (keydown.enter)="rename(t.id, name.value)" (blur)="rename(t.id, name.value)" autofocus />
          } @else {
            <div class="name">{{ t.name }}</div>
            <div class="meta">{{ t.startDate | date:'MMM d' }}–{{ t.endDate | date:'MMM d' }} · {{ t.status }} · {{ t.memberIds.length }} 👤</div>
          }
          <button mat-icon-button class="more" [matMenuTriggerFor]="m" (click)="$event.stopPropagation()">
            <mat-icon>more_horiz</mat-icon>
          </button>
          <mat-menu #m="matMenu">
            <button mat-menu-item (click)="editingId.set(t.id)">Rename</button>
            <button mat-menu-item (click)="remove(t.id)">Delete</button>
          </mat-menu>
        </li>
      } @empty {
        <li class="empty">No trips yet</li>
      }
    </ul>
    @if (error()) { <div class="err">{{ error() }}</div> }`,
  styles: [`
    :host{display:flex;flex-direction:column;height:100%;background:#f7f7f5}
    .head{padding:12px;display:flex;flex-direction:column;gap:6px}
    .list{list-style:none;margin:0;padding:0 8px;overflow:auto;flex:1}
    li{position:relative;padding:8px 36px 8px 10px;border-radius:8px;cursor:pointer}
    li:hover{background:#ecebe7} li.active{background:#e3e1db}
    .name{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .meta{font-size:12px;color:#666}
    .more{position:absolute;right:2px;top:4px;opacity:0} li:hover .more{opacity:1}
    .empty{color:#888;cursor:default}.err{color:#b00020;padding:8px 12px;font-size:12px}`],
})
export class TripList {
  store = inject(TripStore);
  private repo = inject(TripRepo);
  private api = inject(Api);
  private maps = inject(MapsLoader);
  private dialog = inject(MatDialog);
  editingId = signal<string | null>(null);
  busy = signal(false);
  error = signal<string | null>(null);

  // Select a trip and load its chat history
  open(id: string) {
    this.error.set(null);
    this.store.selectTrip(id);
    this.repo.loadTripContext(id).catch(e => this.error.set(e.message));
  }

  // Save a new name; if blank, then cancel
  async rename(id: string, name: string) {
    this.editingId.set(null);
    if (!name.trim()) return;
    try { await this.repo.updateTrip(id, { name: name.trim() }); }
    catch (e: any) { this.error.set(e.message); }
  }

  // Delete after confirmation; only the owner is allowed by the rules
  async remove(id: string) {
    if (!confirm('Delete this trip?')) return;
    try { await this.repo.deleteTrip(id); }
    catch { this.error.set('Only the trip owner can delete it.'); }
  }

  // Queue questionnaire dialog
  newTrip() {
    this.dialog.open(NewTripDialog, { width: '520px' }).afterClosed().subscribe(async (r?: NewTripResult) => {
      if (!r) return;
      try { this.open(await this.repo.createTrip(r)); }
      catch (e: any) { this.error.set(e.message); }
    });
  }

  // Fetch the fixture trip, resolve places, save as a new trip
  async loadDemo() {
    this.busy.set(true);
    this.error.set(null);
    try {
      const trip = await this.api.getMockTrip();
      const stops = await this.maps.resolveStops(trip.stops, String(trip.details['destination'] ?? ''));
      this.open(await this.repo.importTrip({ ...trip, stops }));
    } catch (e: any) {
      this.error.set(e.message);
    } finally {
      this.busy.set(false);
    }
  }
}