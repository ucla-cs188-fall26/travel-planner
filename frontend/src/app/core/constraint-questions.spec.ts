import { describe, expect, it } from 'vitest';
import { ConstraintRecord } from './constraint-models';
import { CONSTRAINT_QUESTIONS, applyConstraintAnswer, confirmConstraintReview, hasAllConstraintAnswers, newConstraintSession } from './constraint-questions';

describe('member constraint elicitation', () => {
  it('maps EUR to integer cents and never treats an A/B preference as hard', () => {
    const session = applyConstraintAnswer(newConstraintSession('alice', 0), 'alice', 'budget', 'A', 1);
    expect(session.constraints).toEqual([{ id: 'alice:budget:budget_max', ownerId: 'alice', kind: 'budget_max', value: 6000, hard: false, sourceQuestionId: 'budget' }]);
    expect(session.confirmed).toBe(false);
    expect(session.revision).toBe(1);
  });

  it('distinguishes indifferent from unanswered without inventing a numeric limit', () => {
    const original = newConstraintSession('alice', 0);
    expect(original.answers).toHaveLength(0);
    const answer = applyConstraintAnswer(original, 'alice', 'walking', 'indifferent', 1);
    expect(answer.answers[0].choice).toBe('indifferent');
    expect(answer.constraints).toEqual([]);
    expect(hasAllConstraintAnswers(answer)).toBe(false);
  });

  it('retracts the changed question inference and retains unrelated explicit conditions and history', () => {
    let session = applyConstraintAnswer(newConstraintSession('alice', 0), 'alice', 'walking', 'A', 1);
    const explicit: ConstraintRecord = { id: 'keep', ownerId: 'alice', kind: 'include_place', value: 'louvre', hard: true, sourceQuestionId: null };
    session = { ...session, confirmed: true, constraints: [...session.constraints, explicit] };
    const revised = applyConstraintAnswer(session, 'alice', 'walking', 'indifferent', 2);
    expect(revised.constraints).toEqual([explicit]);
    expect(revised.answers).toHaveLength(1);
    expect(revised.answerHistory.map(a => a.choice)).toEqual(['A', 'indifferent']);
    expect(revised.confirmed).toBe(false);
    expect(session.confirmed).toBe(true);
  });

  it('requires all five answers before an explicit review, counting indifferent answers', () => {
    let session = newConstraintSession('alice', 0);
    expect(() => confirmConstraintReview(session, 'alice', [], 1)).toThrow(/all five questions/);
    for (const q of CONSTRAINT_QUESTIONS) session = applyConstraintAnswer(session, 'alice', q.id, 'indifferent', 2);
    expect(hasAllConstraintAnswers(session)).toBe(true);
    const confirmed = confirmConstraintReview(session, 'alice', [], 3);
    expect(confirmed.confirmed).toBe(true);
    expect(confirmed.constraints).toEqual([]);
    expect(confirmed.revision).toBe(6);
  });

  it('refuses to mutate another member session or inject a constraint owned by that member', () => {
    let bob = newConstraintSession('bob', 0);
    expect(() => applyConstraintAnswer(bob, 'alice', 'budget', 'A', 1)).toThrow(/your own/);
    for (const q of CONSTRAINT_QUESTIONS) bob = applyConstraintAnswer(bob, 'bob', q.id, 'indifferent', 2);
    expect(() => confirmConstraintReview(bob, 'alice', [], 3)).toThrow(/your own/);
    const foreignConstraint: ConstraintRecord = { id: 'spoof', ownerId: 'alice', kind: 'budget_max', value: 1000, hard: true, sourceQuestionId: null };
    expect(() => confirmConstraintReview(bob, 'bob', [foreignConstraint], 3)).toThrow(/another member/);
  });

  it('maps active hours to destination-local integer minutes and interests to catalog tags', () => {
    const session = applyConstraintAnswer(newConstraintSession('alice', 0), 'alice', 'day-window', 'A', 1);
    expect(session.constraints.map(c => [c.kind, c.value])).toEqual([['day_start_min', 540], ['day_end_max', 1080]]);
    const interest = applyConstraintAnswer(session, 'alice', 'interest', 'A', 2);
    expect(interest.constraints.find(c => c.kind === 'interest')?.value).toBe('art');
    expect(interest.constraints.every(c => !c.hard)).toBe(true);
  });

  it('keeps only the latest 200 answer-history events and retains the current answer', () => {
    let session = newConstraintSession('alice', 0);
    for (let i = 1; i <= 205; i++) session = applyConstraintAnswer(session, 'alice', 'budget', i % 2 ? 'A' : 'B', i);
    expect(session.answerHistory).toHaveLength(200);
    expect(session.answerHistory[0].createdAt).toBe(6);
    expect(session.answers).toHaveLength(1);
    expect(session.answers[0].createdAt).toBe(205);
  });

  it('allows explicit review to establish a hard limit while leaving the answer evidence unchanged', () => {
    let session = newConstraintSession('alice', 0);
    for (const q of CONSTRAINT_QUESTIONS) session = applyConstraintAnswer(session, 'alice', q.id, 'indifferent', 1);
    const hard: ConstraintRecord = { id: 'manual', ownerId: 'alice', kind: 'walking_max', value: 0, hard: true, sourceQuestionId: null };
    const reviewed = confirmConstraintReview(session, 'alice', [hard], 2);
    expect(reviewed.constraints).toEqual([hard]);
    expect(reviewed.answers).toEqual(session.answers);
    expect(reviewed.confirmed).toBe(true);
    expect(session.constraints).toEqual([]);
  });
});
