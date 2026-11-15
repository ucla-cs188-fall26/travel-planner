import { Component, computed, inject, input } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';

interface PlanningNotesData { title: string; summary: string; warnings: string[]; }

@Component({
  selector: 'app-planning-notes-dialog',
  imports: [MatDialogModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content>
      @if (data.summary) { <p class="summary">{{ data.summary }}</p> }
      @if (data.warnings.length) {
        <ul>@for (warning of data.warnings; track $index) { <li>{{ warning }}</li> }</ul>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end"><button mat-button mat-dialog-close>Close</button></mat-dialog-actions>`,
  styles: [`mat-dialog-content{overflow-wrap:anywhere}.summary{white-space:pre-line;line-height:1.5}
            ul{padding-left:20px;margin:0}li{margin:0 0 12px;line-height:1.5;white-space:pre-line}`],
})
export class PlanningNotesDialog { readonly data = inject<PlanningNotesData>(MAT_DIALOG_DATA); }

@Component({
  selector: 'app-planning-notes',
  imports: [MatButtonModule],
  template: `<button mat-button type="button" (click)="open()">
    {{ label() }}@if (notes().length) { ({{ notes().length }}) }
  </button>`,
})
export class PlanningNotes {
  readonly warnings = input<string[]>([]);
  readonly summary = input('');
  readonly title = input('Planning notes');
  readonly label = input('Warnings & estimates');
  readonly notes = computed(() => [...new Set(this.warnings().map(w => w.trim()).filter(Boolean))]);
  private dialog = inject(MatDialog);

  open() {
    this.dialog.open<PlanningNotesDialog, PlanningNotesData>(PlanningNotesDialog, {
      data: { title: this.title(), summary: this.summary(), warnings: this.notes() },
      width: '560px', maxWidth: 'calc(100vw - 32px)', maxHeight: '85vh', autoFocus: 'dialog',
    });
  }
}
