import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatButtonModule } from '@angular/material/button';

// Top navigation bar shown on every page
@Component({
  selector: 'app-nav-bar',
  imports: [RouterLink, RouterLinkActive, MatToolbarModule, MatButtonModule],
  template: `
    <mat-toolbar class="nav">
      <span class="brand">Travel Planner</span>                                      
      <a mat-button routerLink="/planner" routerLinkActive="active">Planner</a>
      <a mat-button routerLink="/profile" routerLinkActive="active">Profile</a> 
      <span class="spacer"></span>
      <!-- TODO: menu with Profile / Sign out, using AuthService -->
    </mat-toolbar>`,
  styles: [`.nav{height:52px;gap:4px}.brand{font-weight:600;margin-right:16px}
            .spacer{flex:1}.active{background:rgba(0,0,0,.06)}`],
})
export class NavBar {}