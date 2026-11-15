import { Component, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { Comparison } from '../core/models';

// Two options side by side with cost, travel time, location and who it suits (picking preferences)
@Component({
  selector: 'app-comparison-card',
  imports: [MatButtonModule],
  template: `
    <div class="prompt">{{ comparison().prompt }}</div>
    <div class="grid">
      @for (o of comparison().options; track o.id) {
        <div class="opt">
          <h4>{{ o.title }}</h4>
          <dl>
            <dt>Cost</dt><dd>{{ o.cost }}</dd>
            <dt>Travel</dt><dd>{{ o.travelTime }}</dd>
            <dt>Where</dt><dd>{{ o.location }}</dd>
            <dt>Suits</dt><dd>{{ o.suits.join(', ') || '—' }}</dd>
          </dl>
          @if (o.sourceUrl) { <a [href]="o.sourceUrl" target="_blank" rel="noopener">Source ↗</a> }
          <button mat-flat-button [disabled]="disabled()" (click)="pick.emit(o.title)">Pick this</button>
        </div>
      }
    </div>`,
  styles: [`.prompt{font-weight:500;margin:8px 0}
            .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
            .opt{background:#fff;border:1px solid #ddd;border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:6px}
            h4{margin:0}dl{display:grid;grid-template-columns:auto 1fr;gap:2px 8px;margin:0;font-size:13px}dt{color:#666}dd{margin:0}`],
})
export class ComparisonCard {
  comparison = input.required<Comparison>();    // The pair to show
  disabled = input(false);                      // True while a request is in flight
  pick = output<string>();                      // Emits the chosen option's title
}