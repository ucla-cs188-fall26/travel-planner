import { ConstraintAnswer, ConstraintKind, ConstraintRecord, MemberConstraintSession } from './constraint-models';

export interface ConstraintQuestionOption {
  label: string;
  description: string;
  constraints: { kind: ConstraintKind; value: number | string }[];
}

export interface ConstraintQuestion {
  id: string;
  version: 1;
  title: string;
  A: ConstraintQuestionOption;
  B: ConstraintQuestionOption;
}

// Choices express a preference. Only the separate review can make a limit hard.
export const CONSTRAINT_QUESTIONS: readonly ConstraintQuestion[] = [
  {
    id: 'budget', version: 1, title: 'Which daily sightseeing and meal budget suits you better?',
    A: { label: 'Up to €60 per person per day', description: 'I prefer to keep costs down.', constraints: [{ kind: 'budget_max', value: 6000 }] },
    B: { label: 'Up to €100 per person per day', description: 'I prefer a wider range of options.', constraints: [{ kind: 'budget_max', value: 10000 }] },
  },
  {
    id: 'day-window', version: 1, title: 'Which activity hours suit you better?',
    A: { label: '09:00–18:00', description: 'I prefer a later start and a restful evening.', constraints: [{ kind: 'day_start_min', value: 540 }, { kind: 'day_end_max', value: 1080 }] },
    B: { label: '08:00–21:00', description: 'I am happy to be out from morning to evening.', constraints: [{ kind: 'day_start_min', value: 480 }, { kind: 'day_end_max', value: 1260 }] },
  },
  {
    id: 'walking', version: 1, title: 'How much walking between stops suits you each day?',
    A: { label: 'Up to 30 minutes per day', description: 'I prefer shorter walks between stops.', constraints: [{ kind: 'walking_max', value: 30 }] },
    B: { label: 'Up to 75 minutes per day', description: 'I am happy to walk farther while exploring.', constraints: [{ kind: 'walking_max', value: 75 }] },
  },
  {
    id: 'pace', version: 1, title: 'How many places would you like to visit each day, excluding meals?',
    A: { label: 'Up to 2 places per day', description: 'I prefer more time at fewer places.', constraints: [{ kind: 'max_activities', value: 2 }] },
    B: { label: 'Up to 4 places per day', description: 'I prefer to visit several places.', constraints: [{ kind: 'max_activities', value: 4 }] },
  },
  {
    id: 'interest', version: 1, title: 'All else equal, which activity should we recommend first?',
    A: { label: 'Art galleries and museums', description: 'I prefer exploring exhibitions.', constraints: [{ kind: 'interest', value: 'art' }] },
    B: { label: 'Parks and nature', description: 'I prefer spending time outdoors.', constraints: [{ kind: 'interest', value: 'nature' }] },
  },
];

export function newConstraintSession(uid: string, now: number): MemberConstraintSession {
  return { uid, schemaVersion: 1, revision: 0, confirmed: false, answers: [], answerHistory: [], constraints: [], updatedAt: now };
}

export function hasAllConstraintAnswers(session: MemberConstraintSession | null): boolean {
  return !!session && CONSTRAINT_QUESTIONS.every(q => session.answers.some(a => a.questionId === q.id && a.questionVersion === q.version));
}

export function applyConstraintAnswer(
  session: MemberConstraintSession, authenticatedUid: string,
  questionId: string, choice: ConstraintAnswer['choice'], now: number,
): MemberConstraintSession {
  assertSessionOwner(session, authenticatedUid);
  const question = CONSTRAINT_QUESTIONS.find(q => q.id === questionId);
  if (!question || !['A', 'B', 'indifferent'].includes(choice)) throw new Error('Unknown question or answer.');
  const answer: ConstraintAnswer = { questionId, questionVersion: 1, choice, createdAt: now };
  const inferred: ConstraintRecord[] = choice === 'indifferent' ? [] : question[choice].constraints.map(c => ({
    id: `${authenticatedUid}:${question.id}:${c.kind}`, ownerId: authenticatedUid,
    kind: c.kind, value: c.value, hard: false, sourceQuestionId: question.id,
  }));
  return {
    ...session, revision: session.revision + 1, confirmed: false, updatedAt: now,
    answers: [...session.answers.filter(a => a.questionId !== questionId), answer],
    answerHistory: [...session.answerHistory, answer].slice(-200),
    constraints: [...session.constraints.filter(c => c.sourceQuestionId !== questionId), ...inferred],
  };
}

export function confirmConstraintReview(
  session: MemberConstraintSession, authenticatedUid: string,
  constraints: ConstraintRecord[], now: number,
): MemberConstraintSession {
  assertSessionOwner(session, authenticatedUid);
  if (!hasAllConstraintAnswers(session)) throw new Error('Answer all five questions before confirming your constraints.');
  if (constraints.some(c => c.ownerId !== authenticatedUid)) throw new Error('You cannot edit another member’s constraints.');
  if (new Set(constraints.map(c => c.id)).size !== constraints.length) throw new Error('Constraint IDs must be unique.');
  return { ...session, constraints: constraints.map(c => ({ ...c })), confirmed: true, revision: session.revision + 1, updatedAt: now };
}

function assertSessionOwner(session: MemberConstraintSession, authenticatedUid: string) {
  if (!authenticatedUid || session.uid !== authenticatedUid || session.constraints.some(c => c.ownerId !== authenticatedUid)) {
    throw new Error('You can only edit your own trip constraints.');
  }
}
