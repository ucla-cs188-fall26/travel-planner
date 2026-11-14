import { MemberConstraintSession } from './constraint-models';
import { Trip } from './models';

// Stable ordering makes real-time Firestore delivery order irrelevant to freshness.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).filter(k => record[k] !== undefined).sort()
      .map(k => JSON.stringify(k) + ':' + canonicalJson(record[k])).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}

export function planningSignature(trip: Trip, members: MemberConstraintSession[], catalogId: string): string {
  return canonicalJson({
    trip: {
      id: trip.id, memberIds: [...trip.memberIds].sort(), startDate: trip.startDate,
      endDate: trip.endDate, details: trip.details, anchors: trip.anchors, stops: trip.stops,
    },
    members: [...members].sort((a, b) => a.uid.localeCompare(b.uid)), catalogId,
  });
}

export async function planningVersion(signature: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signature));
  return 'v1:' + Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}
