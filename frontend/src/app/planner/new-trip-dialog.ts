// planner/new-trip-dialog.ts
import { Component, inject } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatChipsModule, MatChipInputEvent } from '@angular/material/chips';
import { MatButtonModule } from '@angular/material/button';
import { COMMA, ENTER } from '@angular/cdk/keycodes';

//Formatted answers/results from user input for questionnaire
export interface NewTripResult {
  name: string;
  destination: string;
  startDate: string;
  endDate: string;
  anchors: string[];
  memberEmails: string[];
}

// Starting questionnaire: initial trip information, must-dos (anchor events) and members, filled in when creating a trip
@Component({
  selector: 'app-new-trip-dialog',
  imports: [ReactiveFormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatChipsModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>New Trip</h2>
    <form [formGroup]="form" mat-dialog-content class="form">
      <mat-form-field><mat-label>Trip Name</mat-label><input matInput formControlName="name" /></mat-form-field>
      <mat-form-field><mat-label>Destination</mat-label><input matInput formControlName="destination" /></mat-form-field>
      <div class="row"> <!-- Trip dates side by side -->
        <mat-form-field><mat-label>Start</mat-label><input matInput type="date" formControlName="startDate" /></mat-form-field>
        <mat-form-field><mat-label>End</mat-label><input matInput type="date" formControlName="endDate" /></mat-form-field>
      </div>
      <mat-form-field>
        <mat-label>Must-do activities (anchors) — press Enter</mat-label>
        <mat-chip-grid #anchorGrid>
          @for (a of anchors; track a) { <mat-chip-row (removed)="anchors.splice($index,1)">{{ a }}</mat-chip-row> }
        </mat-chip-grid>
        <input [matChipInputFor]="anchorGrid" [matChipInputSeparatorKeyCodes]="sep" (matChipInputTokenEnd)="add(anchors, $event)" />
      </mat-form-field>
      <mat-form-field>
        <mat-label>Members (emails) — press Enter</mat-label>
        <mat-chip-grid #memberGrid>
          @for (m of members; track m) { <mat-chip-row (removed)="members.splice($index,1)">{{ m }}</mat-chip-row> }
        </mat-chip-grid>
        <input [matChipInputFor]="memberGrid" [matChipInputSeparatorKeyCodes]="sep" (matChipInputTokenEnd)="add(members, $event)" />
      </mat-form-field>
    </form>
    <div mat-dialog-actions align="end"> <!-- Cancel closes with no result -->
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button [disabled]="form.invalid" (click)="submit()">Create</button>
    </div>`,
  styles: [`.form{display:flex;flex-direction:column}.row{display:flex;gap:12px}.row>*{flex:1}`],
})
export class NewTripDialog {
  private fb = inject(FormBuilder);
  private ref = inject(MatDialogRef<NewTripDialog>);
  sep = [ENTER, COMMA];
  anchors: string[] = [];
  members: string[] = [];

  // Required trip fields
  form = this.fb.nonNullable.group({
    name: ['', Validators.required],
    destination: ['', Validators.required],
    startDate: ['', Validators.required],
    endDate: ['', Validators.required],
  });

  // Add a typed value, then clear the input
  add(list: string[], e: MatChipInputEvent) {
    const v = (e.value || '').trim();
    if (v) list.push(v);
    e.chipInput.clear();
  }

  // Close the dialog and give the results to TripList
  submit() {
    const result: NewTripResult = { ...this.form.getRawValue(), anchors: this.anchors, memberEmails: this.members };
    this.ref.close(result);
  }
}