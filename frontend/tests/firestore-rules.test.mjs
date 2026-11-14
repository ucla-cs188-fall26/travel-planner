import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';

// Never fall back to a live Firebase project, even when invoked without the CLI.
const emulatorHost = process.env['FIRESTORE_EMULATOR_HOST'];
if (!emulatorHost || !/^(127\.0\.0\.1|localhost):\d+$/.test(emulatorHost)) {
  throw new Error('Run with the local Firestore emulator: npm run test:rules.');
}
const [host, port] = emulatorHost.split(':');
const projectId = 'demo-constraint-rules';
const questionIds = ['budget', 'day-window', 'walking', 'pace', 'interest'];
let environment;

function session(uid = 'alice', patch = {}) {
  return {
    uid, schemaVersion: 1, revision: 1, confirmed: false, answers: [], answerHistory: [],
    constraints: [], updatedAt: 1000, ...patch,
  };
}

function fiveAnswers() {
  return questionIds.map(questionId => ({ questionId, questionVersion: 1, choice: 'indifferent', createdAt: 1000 }));
}

function constraint(index = 0) {
  return { id: `limit-${index}`, ownerId: 'alice', kind: 'budget_max', value: 6000, hard: false, sourceQuestionId: 'budget' };
}

function sessionDoc(db, uid = 'alice', tripId = 'trip-one') {
  return doc(db, 'trips', tripId, 'constraintSessions', uid);
}

async function seedSession(value = session()) {
  await environment.withSecurityRulesDisabled(context => setDoc(sessionDoc(context.firestore(), value.uid), value));
}

async function savedSession(uid = 'alice') {
  let saved;
  await environment.withSecurityRulesDisabled(async context => {
    saved = (await getDoc(sessionDoc(context.firestore(), uid))).data();
  });
  return saved;
}

describe('constraintSessions Firestore security rules', { concurrency: false }, () => {
  before(async () => {
    environment = await initializeTestEnvironment({
      projectId,
      firestore: { host, port: Number(port), rules: await readFile(new URL('../firestore.rules', import.meta.url), 'utf8') },
    });
  });

  beforeEach(async () => {
    await environment.clearFirestore();
    await environment.withSecurityRulesDisabled(context => setDoc(doc(context.firestore(), 'trips', 'trip-one'), {
      ownerId: 'alice', memberIds: ['alice', 'bob'], name: 'Rules test trip', stops: [],
    }));
  });

  after(async () => { await environment?.cleanup(); });

  it('lets a trip member create only their own draft at revision 1', async () => {
    const alice = environment.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(sessionDoc(alice), session()));
    await assertFails(setDoc(sessionDoc(alice, 'bob'), session('bob')));
    const saved = await savedSession();
    assert.equal(saved.uid, 'alice');
    assert.equal(saved.revision, 1);
  });

  it('rejects an authenticated document-owner UID spoof', async () => {
    const alice = environment.authenticatedContext('alice').firestore();
    await assertFails(setDoc(sessionDoc(alice), session('bob')));
    assert.equal(await savedSession(), undefined);
  });

  it('lets all trip members read individual and collection progress', async () => {
    await seedSession();
    const bob = environment.authenticatedContext('bob').firestore();
    const result = await assertSucceeds(getDoc(sessionDoc(bob)));
    assert.equal(result.data().uid, 'alice');
    const progress = await assertSucceeds(getDocs(collection(bob, 'trips', 'trip-one', 'constraintSessions')));
    assert.equal(progress.size, 1);
  });

  it('denies nonmembers and anonymous users both document and collection reads', async () => {
    await seedSession();
    for (const context of [environment.authenticatedContext('mallory'), environment.unauthenticatedContext()]) {
      const db = context.firestore();
      await assertFails(getDoc(sessionDoc(db)));
      await assertFails(getDocs(collection(db, 'trips', 'trip-one', 'constraintSessions')));
    }
  });

  it('denies nonmember and anonymous creates even for their own UID', async () => {
    const outsider = environment.authenticatedContext('mallory').firestore();
    await assertFails(setDoc(sessionDoc(outsider, 'mallory'), session('mallory')));
    const anonymous = environment.unauthenticatedContext().firestore();
    await assertFails(setDoc(sessionDoc(anonymous), session()));
  });

  it('prevents another trip member from updating or replacing the owner session', async () => {
    await seedSession();
    const bob = environment.authenticatedContext('bob').firestore();
    await assertFails(updateDoc(sessionDoc(bob), { revision: 2, confirmed: true, answers: fiveAnswers() }));
    await assertFails(setDoc(sessionDoc(bob), session('alice', { revision: 2 })));
    assert.deepEqual(await savedSession(), session());
  });

  it('requires initial revision 1 and rejects fractional revisions', async () => {
    const alice = environment.authenticatedContext('alice').firestore();
    for (const revision of [0, 2, 1.5]) await assertFails(setDoc(sessionDoc(alice), session('alice', { revision })));
    await assertSucceeds(setDoc(sessionDoc(alice), session()));
  });

  it('accepts only the next revision and protects saved data against stale overwrites', async () => {
    await seedSession();
    const alice = environment.authenticatedContext('alice').firestore();
    const next = session('alice', { revision: 2, constraints: [constraint()], updatedAt: 2000 });
    await assertSucceeds(setDoc(sessionDoc(alice), next));
    await assertFails(setDoc(sessionDoc(alice), session()));
    await assertFails(setDoc(sessionDoc(alice), session('alice', { revision: 4 })));
    await assertFails(updateDoc(sessionDoc(alice), { updatedAt: 3000 }));
    assert.deepEqual(await savedSession(), next);
  });

  it('requires five answers before confirmation and accepts five indifferent answers', async () => {
    const alice = environment.authenticatedContext('alice').firestore();
    await assertFails(setDoc(sessionDoc(alice), session('alice', { confirmed: true, answers: fiveAnswers().slice(0, 4) })));
    await assertSucceeds(setDoc(sessionDoc(alice), session('alice', { confirmed: true, answers: fiveAnswers() })));
    await assertSucceeds(updateDoc(sessionDoc(alice), { revision: 2, confirmed: false }));
    assert.equal((await savedSession()).confirmed, false);
  });

  it('rejects answer, history, and constraint arrays beyond their allowed sizes', async () => {
    const alice = environment.authenticatedContext('alice').firestore();
    const patches = [
      { answers: [...fiveAnswers(), fiveAnswers()[0]] },
      { answerHistory: Array.from({ length: 201 }, () => fiveAnswers()[0]) },
      { constraints: Array.from({ length: 31 }, (_, i) => constraint(i)) },
    ];
    for (const patch of patches) await assertFails(setDoc(sessionDoc(alice), session('alice', patch)));
    await assertSucceeds(setDoc(sessionDoc(alice), session('alice', {
      answers: fiveAnswers(), answerHistory: Array.from({ length: 200 }, () => fiveAnswers()[0]),
      constraints: Array.from({ length: 30 }, (_, i) => constraint(i)),
    })));
  });

  it('validates the exact document shape and numeric updatedAt', async () => {
    const alice = environment.authenticatedContext('alice').firestore();
    const missing = session();
    delete missing.answerHistory;
    for (const invalid of [missing, session('alice', { extra: true }), session('alice', { updatedAt: 'now' }), session('alice', { confirmed: 'yes' })]) {
      await assertFails(setDoc(sessionDoc(alice), invalid));
    }
    // This succeeds only if Firestore compiles and evaluates `updatedAt is number`.
    await assertSucceeds(setDoc(sessionDoc(alice), session('alice', { updatedAt: 1000.5 })));
  });

  it('forbids deleting response history even for the owner', async () => {
    await seedSession();
    const alice = environment.authenticatedContext('alice').firestore();
    await assertFails(deleteDoc(sessionDoc(alice)));
    assert.deepEqual(await savedSession(), session());
  });

  it('revokes session access after a member is removed from the trip', async () => {
    await seedSession();
    await environment.withSecurityRulesDisabled(context => updateDoc(doc(context.firestore(), 'trips', 'trip-one'), { memberIds: ['bob'] }));
    const alice = environment.authenticatedContext('alice').firestore();
    await assertFails(getDoc(sessionDoc(alice)));
    await assertFails(updateDoc(sessionDoc(alice), { revision: 2 }));
  });

  it('does not grant session access under a nonexistent trip', async () => {
    const alice = environment.authenticatedContext('alice').firestore();
    await assertFails(setDoc(sessionDoc(alice, 'alice', 'missing-trip'), session()));
    await assertFails(getDoc(sessionDoc(alice, 'alice', 'missing-trip')));
  });
});
