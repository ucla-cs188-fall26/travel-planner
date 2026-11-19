import { Component, input, output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { PlaceSuggestion } from '../core/models';

@Component({
  selector: 'app-place-suggestions',
  imports: [DecimalPipe, MatButtonModule, MatCheckboxModule],
  template: `
    <section aria-label="Suggested places">
      <div class="heading">More places to explore</div>
      <p class="intro">Choose places to include alongside your must-dos. Times, prices and availability are estimates.</p>
      <div class="places">
        @for (place of suggestions(); track place.id) {
          <div class="place" [class.selected]="selected().includes(place.id)">
            <mat-checkbox [checked]="selected().includes(place.id)" [disabled]="!active() || disabled()"
                          (change)="toggle(place.id, $event.checked)">{{ place.title }}</mat-checkbox>
            <div class="description">
              <div class="name">{{ place.place.name }}</div>
              <p>{{ place.reason }}</p>
              <div class="meta">{{ place.durationMinutes }} min · ~USD {{ place.costCents / 100 | number:'1.0-2' }}/person</div>
            </div>
          </div>
        }
      </div>
      @if (active()) {
        <div class="actions">
          <button mat-flat-button type="button" [disabled]="disabled() || !selected().length" (click)="accept()">
            Build with selected places@if (selected().length) { ({{ selected().length }}) }
          </button>
          @if (canSkip()) { <button mat-button type="button" [disabled]="disabled()" (click)="skipped.emit()">Skip these places</button> }
          <button mat-button type="button" [disabled]="disabled()" (click)="refresh.emit()">Suggest other places</button>
        </div>
      } @else { <div class="previous">Previous suggestions</div> }
    </section>`,
  styles: [`
    :host{display:block;margin-top:12px}.heading{font-weight:600}.intro{font-size:13px;color:#555;line-height:1.5}
    .places{display:grid;gap:10px}.place{border:1px solid #d5d8dc;border-radius:8px;padding:8px;background:#fff}
    .place.selected{border-color:#3d5a80;background:#f1f5fa}.description{padding:0 8px 8px 12px;font-size:13px}
    .description p{line-height:1.5;margin:6px 0}.name,.meta{color:#666}.actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}
    .previous{color:#666;font-size:12px;margin-top:10px}
  `],
})
export class PlaceSuggestions {
  readonly suggestions = input.required<PlaceSuggestion[]>();
  readonly active = input(false);
  readonly disabled = input(false);
  readonly canSkip = input(false);
  readonly accepted = output<string[]>();
  readonly skipped = output<void>();
  readonly refresh = output<void>();
  readonly selected = signal<string[]>([]);

  toggle(id: string, checked: boolean) {
    if (!this.active() || this.disabled() || !this.suggestions().some(p => p.id === id)) return;
    this.selected.update(ids => checked ? [...new Set([...ids, id])] : ids.filter(value => value !== id));
  }

  accept() {
    if (!this.active() || this.disabled()) return;
    const ids = this.selected().filter(id => this.suggestions().some(p => p.id === id));
    if (ids.length) this.accepted.emit(ids);
  }
}
