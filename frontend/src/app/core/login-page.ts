import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { AuthService } from './auth';

// Landing page with the Google sign-in button
@Component({
  selector: 'app-login-page',
  imports: [MatButtonModule],
  template: `
    <div class="wrap">
      <h1>Plan trips [add some good intro]</h1>
      <button mat-flat-button (click)="go()">Sign in with Google</button>
      @if (error()) { <p class="err">{{ error() }}</p> }
    </div>`,
  styles: [`.wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px}
            .err{color:#b00020}`],
})
export class LoginPage {
  private auth = inject(AuthService);
  private router = inject(Router);
  error = signal<string | null>(null);

  // Sign in, then go to the planner
  async go() {
    try {
      await this.auth.signIn();
      this.router.navigate(['/planner']);
    } catch (e: any) {
      this.error.set(e?.message ?? 'Sign-in failed');
    }
  }
}