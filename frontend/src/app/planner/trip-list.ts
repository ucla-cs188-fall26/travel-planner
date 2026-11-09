import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatDialog } from '@angular/material/dialog';
import { TripStore } from '../core/trip-store';
import { TripSchema } from '../core/models';
import { NewTripDialog, NewTripResult } from './new-trip-dialog';

// Left pane: list of trips styled like chat sessions, with new / rename / delete
@Component({
  selector: 'app-trip-list',
  imports: [DatePipe, MatButtonModule, MatIconModule, MatMenuModule],
  template: `
    <div class="head">
      <button mat-flat-button (click)="newTrip()"><mat-icon>add</mat-icon>New Trip</button>
    </div>
    <ul class="list">
      @for (t of store.trips(); track t.id) {   <!-- One row per trip -->
        <li [class.active]="t.id === store.activeTripId()" (click)="open(t.id)">
          @if (editingId() === t.id) { 
            <input #name [value]="t.name" (click)="$event.stopPropagation()"
                   (keydown.enter)="rename(t.id, name.value)" (blur)="rename(t.id, name.value)" autofocus />
          } @else {  <!-- Normal row: name + meta -->
            <div class="name">{{ t.name }}</div>
            <div class="meta">
              {{ t.startDate | date:'MMM d' }}–{{ t.endDate | date:'MMM d' }} · {{ t.status }} · {{ t.memberIds.length }} 👤
            </div>
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
    </ul>`,
  styles: [`
    :host{display:flex;flex-direction:column;height:100%;background:#f7f7f5}
    .head{padding:12px}
    .list{list-style:none;margin:0;padding:0 8px;overflow:auto}
    li{position:relative;padding:8px 36px 8px 10px;border-radius:8px;cursor:pointer}
    li:hover{background:#ecebe7} li.active{background:#e3e1db}
    .name{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .meta{font-size:12px;color:#666}
    .more{position:absolute;right:2px;top:4px;opacity:0} li:hover .more{opacity:1}
    .empty{color:#888;cursor:default}`],
})
export class TripList {
  store = inject(TripStore);
  private dialog = inject(MatDialog); 
  editingId = signal<string | null>(null);

  // Select a trip so every pane shows it
  open(id: string) {
    this.store.selectTrip(id);
  }

  // Save a new name, or cancel if it's blank
  rename(id: string, name: string) {
    this.editingId.set(null);
    const t = this.store.trips().find(x => x.id === id);
    if (t && name.trim()) this.store.upsertTrip({ ...t, name: name.trim() });
  }

  // Delete after a confirmation
  remove(id: string) {
    if (confirm('Delete this trip?')) this.store.removeTrip(id);
  }

  // Open the questionnaire dialog, then create and open the trip
  newTrip() {
    this.dialog.open(NewTripDialog, { width: '520px' }).afterClosed().subscribe((r?: NewTripResult) => {
      if (!r) return;                                                    
      const trip = TripSchema.parse({
        id: crypto.randomUUID(),
        name: r.name,
        ownerId: 'local',  //TODO: get real user UID from profile page when created
        memberIds: ['local'], //TODO: look up memberEmails when profile page is created
        startDate: r.startDate,
        endDate: r.endDate,
        details: { destination: r.destination, startDate: r.startDate, endDate: r.endDate },
        anchors: r.anchors,
      });
      this.store.upsertTrip(trip);
      this.open(trip.id);
    });
  }
}