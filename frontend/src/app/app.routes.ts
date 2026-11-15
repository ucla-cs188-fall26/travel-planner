import { Routes } from '@angular/router';
import { authGuard } from './core/auth';

//routing to pages; profile and planner require user sign-in
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'planner' },                                                   
  { path: 'login', loadComponent: () => import('./core/login-page').then(m => m.LoginPage) },     
  { path: 'planner', canActivate: [authGuard], loadComponent: () => import('./planner/planner-page').then(m => m.PlannerPage) },
  { path: 'profile', canActivate: [authGuard], loadComponent: () => import('./profile/profile-page').then(m => m.ProfilePage) },
  { path: '**', redirectTo: 'planner' },                                                                      
];