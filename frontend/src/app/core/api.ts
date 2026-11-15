import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, map, Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  ChatMessage, ChatResponse, ChatResponseSchema, EditDiff, GroupPreferences,
  ChangeResponse, ChangeResponseSchema, Trip, TripSchema,
} from './models';

@Injectable({ providedIn: 'root' })
export class Api {
  private http = inject(HttpClient);
  private base = environment.useMock ? '/api' : environment.apiBaseUrl;

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
  }): Promise<ChatResponse> {
    return firstValueFrom(
      this.http.post(`${this.base}/chat`, body).pipe(map(r => this.parse(ChatResponseSchema, r, 'chat'))),
    );
  }

  //sends calendar edits and return LLM's proposed change through POST /api/itinerary/change
  change(body: { diff: EditDiff[]; trip: Trip; groupPreferences: GroupPreferences | null }): Observable<ChangeResponse> {
    return this.http.post(`${this.base}/itinerary/change`, body)
      .pipe(map(r => this.parse(ChangeResponseSchema, r, 'change')));
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