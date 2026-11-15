import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { catchError, firstValueFrom, map, Observable, throwError } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  ChatMessage, ChatResponse, ChatResponseSchema, EditDiff, GroupPreferences,
  ChangeResponse, ChangeResponseSchema, Trip, TripSchema, SuggestionDecision,
} from './models';

@Injectable({ providedIn: 'root' })
export class Api {
  private http = inject(HttpClient);
  private base = (environment.apiBaseUrl || '/api').replace(/\/$/, '');

  //loads the proposed trip through GET/api/trip
  getMockTrip(): Promise<Trip> {
    return firstValueFrom(this.http.get(`${this.base}/trip`).pipe(map(r => TripSchema.parse(r))));
  }

  //sends message and information that LLM needs through POST /api/chat
  chat(body: {
    message: string;
    trip: Trip;
    groupPreferences: GroupPreferences | null;
    recentMessages: ChatMessage[];
    suggestionDecision?: SuggestionDecision;
  }): Promise<ChatResponse> {
    return firstValueFrom(
      this.http.post(`${this.base}/chat`, body).pipe(
        map(r => this.parse<ChatResponse>(ChatResponseSchema, r, 'chat')),
        catchError(e => throwError(() => this.error(e))),
      ),
    );
  }

  //sends calendar edits and return LLM's proposed change through POST /api/itinerary/change
  change(body: { diff: EditDiff[]; trip: Trip; groupPreferences: GroupPreferences | null }): Observable<ChangeResponse> {
    return this.http.post(`${this.base}/itinerary/change`, body)
      .pipe(map(r => this.parse<ChangeResponse>(ChangeResponseSchema, r, 'change')),
            catchError(e => throwError(() => this.error(e))));
  }

  private error(error: any): Error {
    return new Error(typeof error?.error?.detail === 'string'
      ? error.error.detail
      : error?.status === 0 ? 'Cannot reach the planner. Check that the Python server is running.'
      : error?.message ?? 'The planner request failed.');
  }

  //checks a raw response against its corresponding designed schema
  private parse<T>(schema: { safeParse: (x: unknown) => any }, raw: unknown, label: string): T {
    const res = schema.safeParse(raw);
    if (!res.success) {
      console.error(`[api] invalid ${label} response`, res.error.issues, raw);
      throw new Error(`The planner returned data in an unexpected format (${label}).`);
    }
    return res.data;
  }
}
