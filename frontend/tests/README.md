# Local Firestore rules tests

These tests use `@firebase/rules-unit-testing` with the local Firestore emulator and a fixed `demo-constraint-rules` project. No Firebase login, deployment, real project, or service-account credentials are used. The tests reject a missing or non-loopback emulator address.

Prerequisites: Node 22, Java 11+ compatible with the installed Firebase CLI, and Firebase CLI 14.3.1. That CLI works with the project's Java 19 environment. Newer Firebase CLIs may require a newer Java runtime.

```sh
cd frontend/tests
npm ci
npm run test:rules
```

If no Firebase CLI is installed, use a pinned CLI without changing the global installation:

```sh
npm run pretest:rules
npx firebase-tools@14.3.1 emulators:exec --only firestore --project demo-constraint-rules --config firebase.rules-test.json "node --test firestore-rules.test.mjs"
```

The CLI may download the emulator on first run. It binds `127.0.0.1:8089`, loads a generated copy of `../firestore.rules`, starts the tests, and shuts down afterward. The test harness also loads the app's original rule file directly. Tests seed a two-member trip with `withSecurityRulesDisabled` and clear emulator data between cases.

The npm runner passes the absolute current Node executable to the CLI, avoiding the older bundled Node in standalone Firebase CLI binaries.

Coverage: member-only reads, own-document writes, UID spoofing, exact revision increments, stale-write rejection, confirmation answer count, collection limits, exact top-level shape, numeric timestamps, deletion denial, and removed-member access. Detailed constraint semantics remain validated by frontend schemas and the solver; these rules enforce the session envelope and ownership boundary.

Official references: [Firebase Security Rules unit tests](https://firebase.google.com/docs/rules/unit-tests), [Local Emulator Suite setup](https://firebase.google.com/docs/emulator-suite/install_and_configure).
