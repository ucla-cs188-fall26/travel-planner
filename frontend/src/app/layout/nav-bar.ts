import { Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule } from '@angular/material/menu';
import { AuthService } from '../core/auth';

// Top bar: page links on the left, avatar menu on the right (only when signed in)
@Component({
  selector: 'app-nav-bar',
  imports: [RouterLink, RouterLinkActive, MatToolbarModule, MatButtonModule, MatMenuModule],
  template: `
    <mat-toolbar class="nav">
      <span class="brand">Travel Planner</span>
      @if (auth.user(); as u) {
        <a mat-button routerLink="/planner" routerLinkActive="active">Planner</a>
        <a mat-button routerLink="/profile" routerLinkActive="active">Profile</a>
        <span class="spacer"></span>
        <button mat-button [matMenuTriggerFor]="menu">
          @if (u.photoURL) { <img [src]="u.photoURL" alt="" class="avatar" referrerpolicy="no-referrer" /> }
          {{ u.displayName }}
        </button>
        <mat-menu #menu="matMenu">
          <button mat-menu-item routerLink="/profile">Profile</button>
          <button mat-menu-item (click)="signOut()">Sign Out</button>
        </mat-menu>
      }
    </mat-toolbar>`,
  styles: [`.nav{height:52px;gap:4px}.brand{font-weight:600;margin-right:16px}
            .spacer{flex:1}.active{background:rgba(0,0,0,.06)}
            .avatar{width:26px;height:26px;border-radius:50%;vertical-align:middle;margin-right:6px}`],
})
export class NavBar {
  auth = inject(AuthService);
  private router = inject(Router);

  // Sign out, then return to the login page
  async signOut() {
    await this.auth.signOut();
    this.router.navigate(['/login']);
  }
}