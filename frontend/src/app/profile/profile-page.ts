import { Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { Firestore, doc, getDoc, updateDoc } from '@angular/fire/firestore';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { AuthService } from '../core/auth';
import { PreferencesSchema } from '../core/models';

const INTERESTS = ['nature', 'museum', 'shopping', 'history', 'photography', 'nightlife', 'food'];
const DIETARY = ['vegetarian', 'vegan', 'halal', 'kosher', 'gluten-free', 'nut allergy'];

// Personal preferences saved to users/{uid}.preferences; reused on every trip
@Component({
  selector: 'app-profile-page',
  imports: [ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule],
  template: `
    <form class="form" [formGroup]="form" (ngSubmit)="save()">
      <h2>Your Travel Preferences</h2>
      <mat-form-field><mat-label>Budget per day (USD)</mat-label>
        <input matInput type="number" formControlName="budgetPerDay" /></mat-form-field>
      <div class="row">                                                            <!-- Active hours -->
        <mat-form-field><mat-label>Wake up</mat-label><input matInput type="time" formControlName="activeStart" /></mat-form-field>
        <mat-form-field><mat-label>Bedtime</mat-label><input matInput type="time" formControlName="activeEnd" /></mat-form-field>
      </div>
      <mat-form-field><mat-label>Interests</mat-label>
        <mat-select multiple formControlName="interests">
          @for (i of interests; track i) { <mat-option [value]="i">{{ i }}</mat-option> }
        </mat-select></mat-form-field>
      <mat-form-field><mat-label>Dietary needs</mat-label>
        <mat-select multiple formControlName="dietary">
          @for (d of dietary; track d) { <mat-option [value]="d">{{ d }}</mat-option> }
        </mat-select></mat-form-field>
      <div class="row">
        <mat-form-field><mat-label>Activity level</mat-label>
          <mat-select formControlName="activityLevel">
            <mat-option value="low">Low</mat-option><mat-option value="medium">Medium</mat-option><mat-option value="high">High</mat-option>
          </mat-select></mat-form-field>
        <mat-form-field><mat-label>Pace</mat-label>
          <mat-select formControlName="pace">
            <mat-option value="relaxed">Relaxed</mat-option><mat-option value="balanced">Balanced</mat-option><mat-option value="packed">Packed</mat-option>
          </mat-select></mat-form-field>
      </div>
      <button mat-flat-button [disabled]="saving()">Save</button>
    </form>`,
  styles: [`.form{max-width:560px;margin:32px auto;display:flex;flex-direction:column}
            .row{display:flex;gap:12px}.row>*{flex:1}`],
})
export class ProfilePage implements OnInit {
  private fb = inject(FormBuilder);
  private db = inject(Firestore);
  private auth = inject(AuthService);
  private snack = inject(MatSnackBar);
  interests = INTERESTS;
  dietary = DIETARY;
  saving = signal(false);

  // Form fields with defaults for a new user
  form = this.fb.group({
    budgetPerDay: [null as number | null],
    activeStart: ['08:00'],
    activeEnd: ['22:00'],
    interests: [[] as string[]],
    dietary: [[] as string[]],
    activityLevel: ['medium'],
    pace: ['balanced'],
  });

  // Load saved preferences into the form
  async ngOnInit() {
    const uid = this.auth.user()?.uid;
    if (!uid) return;
    const p = (await getDoc(doc(this.db, 'users', uid))).data()?.['preferences'] ?? {};
    this.form.patchValue({
      budgetPerDay: p.budgetPerDay ?? null,
      activeStart: p.activeHours?.start ?? '08:00',
      activeEnd: p.activeHours?.end ?? '22:00',
      interests: p.interests ?? [],
      dietary: p.dietary ?? [],
      activityLevel: p.activityLevel ?? 'medium',
      pace: p.pace ?? 'balanced',
    });
  }

  // Validate with schema, then save to Firestore
  async save() {
    const uid = this.auth.user()?.uid;
    if (!uid) return;
    const v = this.form.getRawValue();
    const preferences = PreferencesSchema.parse({
      budgetPerDay: v.budgetPerDay ?? undefined,
      activeHours: { start: v.activeStart, end: v.activeEnd },
      interests: v.interests,
      dietary: v.dietary,
      activityLevel: v.activityLevel,
      pace: v.pace,
    });
    this.saving.set(true);
    try {
      await updateDoc(doc(this.db, 'users', uid), { preferences });
      this.snack.open('Preferences saved', undefined, { duration: 2000 });
    } finally {
      this.saving.set(false);
    }
  }
}