import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { catchError, firstValueFrom, map, Observable, throwError, timeout, TimeoutError } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  ChatMessage, ChatResponse, ChatResponseSchema, EditDiff, GroupPreferences,
  ChangeResponse, ChangeResponseSchema, Trip, TripSchema, SuggestionDecision,
} from './models';

// timeout to break when the process is too slow
const LLM_TIMEOUT_MS = 120_000;
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
        timeout(LLM_TIMEOUT_MS),
        map(r => this.parse<ChatResponse>(ChatResponseSchema, r, 'chat')),
        catchError(e => throwError(() => this.error(e))),
      ),
    );
  }

  //sends calendar edits and return LLM's proposed change through POST /api/itinerary/change
  change(body: { diff: EditDiff[]; trip: Trip; groupPreferences: GroupPreferences | null }): Observable<ChangeResponse> {
    return this.http.post(`${this.base}/itinerary/change`, body)
      .pipe(timeout(LLM_TIMEOUT_MS),
            map(r => this.parse<ChangeResponse>(ChangeResponseSchema, r, 'change')),
            catchError(e => throwError(() => this.error(e))));
  }

  private error(error: any): Error {
    if (error instanceof TimeoutError) return new Error('The planner is taking too long to respond. Try again.');
    const detail = error?.error?.detail;
    if (typeof detail === 'string') return new Error(detail);
    if (Array.isArray(detail) && detail[0]?.msg) {
      console.error('[api] request rejected (422)', detail);
      return new Error(`The planner rejected the request: ${detail[0].msg} (${(detail[0].loc ?? []).join('.')})`);
    }
    if (error?.status === 0) return new Error('Cannot reach the planner. Check that the Python server is running.');
    return new Error(error?.message ?? 'The planner request failed.');
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
