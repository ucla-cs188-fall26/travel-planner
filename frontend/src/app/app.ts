import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { NavBar } from './layout/nav-bar';

// Root component: nav bar on top, the current route's page below it
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, NavBar],                                        
  template: `<app-nav-bar /><main class="app-main"><router-outlet /></main>`, 
  styles: [`:host{display:flex;flex-direction:column;height:100vh}
            .app-main{flex:1;min-height:0}`], 
})
export class App {}