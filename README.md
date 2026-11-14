# Travel Planner

An Angular/Firebase travel planner with a Python/Z3 prototype for collecting group constraints and proposing itineraries.

Each member signs in, answers with A, B, or No preference, and confirms their requirements and preferences in the review screen. Once every member confirms, Z3 **proposes** a shared itinerary. Generating a proposal, changing answers, dragging calendar events, or receiving chat responses does not modify the saved itinerary. **Only clicking `Accept this proposal`** checks the latest trip and member responses again in a Firestore transaction and saves the proposal.

## Run locally

Use a Node.js version supported by the project's Angular dependencies: `^20.19.0`, `^22.12.0`, or `>=24`. Python 3.11 or later and `uv` are also required.

If the frontend environment files are missing, copy `frontend/src/environments/environment.example.ts` to `environment.ts` and `environment.development.ts` in the same directory. Fill in the Firebase web app configuration, Google Maps API key, and Map ID. Set `production: false` in the development file and `production: true` in the default file. For local mock chat, set `useMock: true` in both files. Both actual configuration files are excluded from Git.

Terminal 1 — Z3 proposal server:

```bash
cd solver-server
uv venv .venv
uv pip install --python .venv/bin/python -r requirements-dev.txt
.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 3001
```

Terminal 2 — existing mock chat server:

```bash
cd mock-server
npm ci
node server.js
```

Terminal 3 — Angular:

```bash
cd frontend
npm ci
npm start
```

Open [localhost:4200](http://localhost:4200) in your browser. `/solver-api` proxies to port 3001, and the existing `/api` proxies to port 3000. Restart an already running development server so it loads the proxy configuration.

Configure Google sign-in in Firebase Authentication, a Firestore database, and `localhost` as an authorized authentication domain. To use the new `constraintSessions` storage path, deploy `frontend/firestore.rules` to the Firebase project. This branch does not change remote Firebase settings automatically. A project administrator can sign in with the Firebase CLI and run:

```bash
cd frontend
npx firebase-tools deploy --only firestore:rules --project travel-planner-5579c
```

## User flow

1. Create a 1–3 day trip to `Paris` or `Paris, France`, or select `Load Demo Trip`. The supported Korean destination aliases are also accepted.
2. Ask each companion to sign in once, then add them by email in the trip's group panel.
3. Each member answers the five comparison questions from their own account. `No preference` adds no preference for that comparison; it does not remove unrelated existing constraints.
4. Review the budget, active hours, walking time, visit count, interests, and required or excluded places. A/B answers start as preferences. A member must explicitly select `Required` to make a condition a hard requirement. Select `Confirm my constraints` when the review is complete.
5. Once every member confirms, select `Suggest an itinerary`. Review the preview and individual preference scores, then select `Accept this proposal` or `Dismiss proposal`.
6. Dragging a calendar event computes a change proposal while preserving the original itinerary. Nothing is saved before acceptance. New answers or itinerary changes invalidate an older proposal.
7. If hard requirements conflict, the system explains the related constraints. The affected members edit and confirm their own review, then request another proposal. Hard requirements are never relaxed automatically.

## Data and scope

The solver uses the fixed Paris sample in `shared/fixtures/solver-catalog.json`. Costs are EUR cents per person; times and walking durations are in minutes. Costs include visits and lunch only, excluding flights, accommodation, and actual booking prices. Opening hours and walking routes are simulated. Google Maps provides visualization; it does not replace the solver's inputs with live routes.

Each day includes one lunch and sightseeing activities. Constraints check travel between adjacent visits and to/from the base, opening hours, visit durations, individual limits and required places, and locked stops. The sample does not allow repeated visits to the same place during a trip. Unsupported destinations, locked places, or required-place information produce an insufficient-data result. The solver does not silently substitute another city or ignore locks.

After checking hard requirements, the server normalizes individual preference scores and optimizes the group objectives. It distinguishes `unsat`, timeouts or undecided results, and insufficient data. If a validated solution exists but optimality cannot be proven within the optimization deadline, the proposal includes a warning. Scores measure satisfaction of the implemented rules; they do not measure actual user satisfaction.

Firebase and its security rules handle sign-in and storage of each member's responses. The Python server computes only the snapshot received locally; it has no Firebase credentials or save/accept API. Public deployment additionally requires server-side authentication and request limits.

## Verification

```bash
cd solver-server
.venv/bin/python -m pytest -q
```

```bash
cd frontend
npm test -- --watch=false
npm run build -- --configuration development
```

Testing the actual Firestore security rules in the local emulator requires Java compatible with Firebase CLI 14.3.1. These tests do not connect to the remote project.

```bash
cd frontend/tests
npm ci
npm run test:rules
```

The API and type contract is documented in [shared/contracts/constraint-solver.md](shared/contracts/constraint-solver.md).

The architecture takes inspiration from PLanet's user specification → domain rules → logical constraints → solver → explainable results pipeline. Comparison questions, preferences, and group optimization were designed for the travel domain. [PLanet paper](https://arxiv.org/html/2505.09094v3#S4)
