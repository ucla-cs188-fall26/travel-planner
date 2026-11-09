import { Routes } from '@angular/router';

//pages lazy-load so each one downloads only when visited
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'planner' },                                                   
  { path: 'planner', loadComponent: () => import('./planner/planner-page').then(m => m.PlannerPage) },        
  // TODO: add the profile route 
  // TODO add the /login route
  { path: '**', redirectTo: 'planner' },                                                                      
];