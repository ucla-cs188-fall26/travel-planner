import { Component } from '@angular/core';
import { SplitComponent, SplitAreaComponent } from 'angular-split';
import { TripList } from './trip-list';
import { ChatPanel } from './chat-panel';
import { CalendarPanel } from './calendar-panel';
import { MapPanel } from './map-panel';

// Three-pane planner: trip list | chat | calendar over map
@Component({
  selector: 'app-planner-page',
  imports: [SplitComponent, SplitAreaComponent, TripList, CalendarPanel, MapPanel, ChatPanel],
  template: `
    <as-split direction="horizontal" unit="percent" gutterSize="6">
      <as-split-area [size]="20" [minSize]="14"><app-trip-list /></as-split-area> <!-- list of trips -->
      <as-split-area [size]="55" [minSize]="30"><app-chat-panel /></as-split-area> <!-- chat panel for active trip -->
      <as-split-area [size]="25" [minSize]="20"> 
        <as-split direction="vertical" unit="percent" gutterSize="6">
          <as-split-area [size]="50"><app-calendar-panel /></as-split-area> <!-- calendar view for active trip -->
          <as-split-area [size]="50"><app-map-panel /></as-split-area>  <!-- map view for active trip -->
        </as-split>
      </as-split-area>
    </as-split>`,
  styles: [`:host{display:block;height:100%}
            as-split-area{display:flex;flex-direction:column;overflow:hidden}`],
})
export class PlannerPage {}