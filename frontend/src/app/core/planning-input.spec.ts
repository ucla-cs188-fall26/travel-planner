import { MemberConstraintSession } from './constraint-models';
import { TripSchema } from './models';
import { canonicalJson, planningSignature } from './planning-input';

describe('planning input freshness', () => {
  const trip = TripSchema.parse({
    id: 'trip-1', name: 'Paris', ownerId: 'alice', memberIds: ['alice', 'bob'],
    startDate: '2026-11-20', endDate: '2026-11-21',
    details: { destination: 'Paris', budget: 100 },
    stops: [{ id: 'museum', day: 1, title: 'Museum', start: '2026-11-20T10:00:00',
      end: '2026-11-20T11:00:00', place: { name: 'Museum' } }],
  });
  const member = (uid: string): MemberConstraintSession => ({
    uid, schemaVersion: 1, revision: 1, confirmed: true, answers: [], answerHistory: [],
    constraints: [{ id: `${uid}:budget`, ownerId: uid, kind: 'budget_max', value: 100,
      hard: true, sourceQuestionId: null }], updatedAt: 1,
  });

  it('ignores object key order and undefined optional fields', () => {
    expect(canonicalJson({ b: 2, a: { y: 2, x: 1 }, optional: undefined }))
      .toBe(canonicalJson({ a: { x: 1, y: 2 }, b: 2 }));
  });

  it('ignores Firestore member delivery order and trip member order', () => {
    const baseline = planningSignature(trip, [member('alice'), member('bob')], 'paris-v1');
    expect(planningSignature({ ...trip, memberIds: ['bob', 'alice'],
      details: { budget: 100, destination: 'Paris' } }, [member('bob'), member('alice')], 'paris-v1'))
      .toBe(baseline);
  });

  it('invalidates the proposal when dates, stops, anchors, members, conditions or catalog change', () => {
    const members = [member('alice'), member('bob')];
    const baseline = planningSignature(trip, members, 'paris-v1');
    const alteredTrips = [
      { ...trip, endDate: '2026-11-22' },
      { ...trip, stops: trip.stops.map(s => ({ ...s, start: '2026-11-20T11:00:00' })) },
      { ...trip, anchors: ['museum'] },
      { ...trip, memberIds: ['alice'] },
      { ...trip, details: { ...trip.details, budget: 50 } },
    ];
    for (const changed of alteredTrips) {
      expect(planningSignature(changed, members, 'paris-v1')).not.toBe(baseline);
    }
    expect(planningSignature(trip, [{ ...members[0], revision: 2 }, members[1]], 'paris-v1')).not.toBe(baseline);
    expect(planningSignature(trip, members, 'paris-v2')).not.toBe(baseline);
  });
});
