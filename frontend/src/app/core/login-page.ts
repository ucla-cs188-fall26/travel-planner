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
      <h1>Plan your trip</h1>
      <button mat-flat-button type="button" (click)="go()">Sign in with Google</button>
      @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
    </div>`,
  styles: [`
    /* Hallmark · genre: modern-minimal · tone: utilitarian · theme: existing Material
     * pre-emit critique: P5 H4 E5 S4 R5 V3 */
    :host{display:block;height:100%}
    .wrap{box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100%;padding:24px;gap:24px;text-align:center}
    h1{margin:0;font-size:24px;font-weight:500;line-height:1.3;letter-spacing:-.02em;overflow-wrap:anywhere}
    button{max-width:100%;white-space:nowrap}
    .err{max-width:320px;margin:0;color:var(--mat-sys-error);font-size:14px;overflow-wrap:anywhere}
  `],
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
