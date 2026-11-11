import { Injectable, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Auth, GoogleAuthProvider, authState, signInWithPopup, signOut } from '@angular/fire/auth';
import { Firestore, doc, getDoc, setDoc, serverTimestamp } from '@angular/fire/firestore';
import { CanActivateFn, Router } from '@angular/router';
import { map, take } from 'rxjs';

//wrap Firebase Auth: the current user as a signal, plus sign-in/out
@Injectable({ providedIn: 'root' })
export class AuthService {
  private auth = inject(Auth);
  private db = inject(Firestore);
  readonly user$ = authState(this.auth);
  readonly user = toSignal(this.user$, { initialValue: null });

  // Google popup sign-in; creates users/{uid} on first login so members can be found by email
  async signIn() {
    const { user: u } = await signInWithPopup(this.auth, new GoogleAuthProvider());
    const ref = doc(this.db, 'users', u.uid);
    if (!(await getDoc(ref)).exists()) {
      await setDoc(ref, {
        uid: u.uid,
        email: u.email?.toLowerCase() ?? null,
        displayName: u.displayName ?? u.email ?? 'Traveler',
        photoURL: u.photoURL ?? null,
        preferences: { interests: [], dietary: [] },
        createdAt: serverTimestamp(),
      });
    }
  }

  signOut() { return signOut(this.auth); } // Ends the session and the guard sends the user to /login
}

//Lets a route open only when signed in; otherwise redirects to /login
export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.user$.pipe(take(1), map(u => (u ? true : router.createUrlTree(['/login']))));
};