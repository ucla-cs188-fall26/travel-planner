# Travel Planner

Angular frontend, Firebase Auth/Firestore storage, and a Python FastAPI backend that uses an
OpenAI-compatible LLM to extract constraints and Z3 to schedule activities.

```text
Browser → Angular :4200 → /api proxy → FastAPI :8000
                                      ├─ llm.py → configured LLM provider
                                      └─ validated constraints → Z3 → Stop[] → calendar
Browser → Firebase Auth / Firestore and Google Maps / Places
```

## Submission links

- GitHub repository: [ucla-cs188-fall26/travel-planner](https://github.com/ucla-cs188-fall26/travel-planner)
- Walkthrough video: [Watch on Google Drive](https://drive.google.com/file/d/1dclnz_-ZH5JGLAi8_6TwFyQFGalbSkaN/view?usp=drive_link)

## Run locally

### 1. Prerequisites and clone

- Python 3.11 or newer.
- Node.js 22.12+ (22.x) or 24+ and npm (the project specifies npm 11).
- An OpenAI-compatible LLM API key, base URL, and model name.
- Firebase web app configuration with Google sign-in enabled, `localhost` authorized
  for authentication, and a Firestore database with rules permitting the app's user,
  trip, and trip-message operations for authorized users.
- A Google Maps API key with Maps JavaScript API and Places API (New) enabled,
  plus a map ID, for the map view and place lookup.

Use the team's configured Firebase/Google Maps project if you have access. Configuration
files and API credentials are not included in the repository; obtain them from the team
or configure your own services before running the full scenario.

```sh
git clone https://github.com/ucla-cs188-fall26/travel-planner.git
cd travel-planner
```

### 2. Install and configure the backend

From the repository root:

```sh
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
```

If `backend/.env` does not exist, copy the example:

```sh
cp backend/.env.example backend/.env
```

Edit `backend/.env` and set `API_KEY`, `BASE_URL`, and `MODEL` for your provider.
The backend loads this file independently of the shell's working directory. The LLM API key
stays in the backend and is never returned by health checks.

### 3. Configure the frontend

If these files do not already exist, create them from the example:

```sh
cp frontend/src/environments/environment.example.ts frontend/src/environments/environment.ts
cp frontend/src/environments/environment.example.ts frontend/src/environments/environment.development.ts
```

In **both files**, replace `googleMapsApiKey`, `googleMapId`, and the `firebase` object
with your project's configuration. The Firebase object should contain your web app's
`apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, and `appId`.
Keep `useMock: false` and `apiBaseUrl: '/api'` for the real LLM + Z3 scenario.
These local configuration files and `backend/.env` are Git-ignored.

### 4. Start both servers

Terminal 1, from the repository root:

```sh
backend/.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
```

Terminal 2, from the repository root:

```sh
cd frontend
npm ci
npm start
```

Open [http://localhost:4200](http://localhost:4200). Requests to `/api` are proxied to
FastAPI on port 8000. [The health endpoint](http://127.0.0.1:8000/api/health) can confirm
that the backend is running and LLM settings are present; it does not test a provider call.
Keep both terminals running while trying the scenario below.

## Core scenario walkthrough

**Goal:** Turn natural-language travel preferences into an editable itinerary that satisfies
explicit scheduling constraints, with user approval of suggested places and schedule changes.

1. Open the app and click **Sign in with Google**.
2. Create a **New Trip** with a name, destination, start/end dates, and must-do activities.
   For a small example, use Paris, a single day, and Luxembourg Gardens as a must-do.
   Members are optional; leave them empty for a solo walkthrough.
3. Enter preferences in chat, for example:
   > Plan a relaxed day in Paris, 09:00–18:00, with Luxembourg Gardens and French food.
   > USD 60 per person for today's activities and meals.

   Send the message, or click **Suggest first itinerary** to use the trip details and
   preferences currently typed in the composer. Answer any follow-up questions.
4. Review the suggested place cards, select the places you want, and click
   **Build with selected places**. The backend converts the request to structured
   constraints and uses Z3 to schedule the must-dos and selected places. If constraints
   conflict, follow the explanation and revise the selection or preferences.
5. Inspect the generated itinerary in the calendar and map. The feasible schedule is saved
   to Firestore; map coordinates are enriched afterward. Open an activity to see its details
   and review the planning warnings/estimates.
6. Change an unlocked activity's time by dragging/resizing it in the calendar, or open its
   details, edit the date/start/end, and click **Save time**. Unlock it first if necessary.
   The backend checks the edit against saved constraints and proposes an updated schedule.
   Review the changes and choose **Accept** to save them or **Revert** to restore the prior
   schedule. If the edit is infeasible, use the displayed conflict explanation and recovery controls.
7. Reload the app and reopen the trip to confirm that the saved itinerary and chat history persist.

**Expected outcome:** A saved, editable itinerary containing the must-do and selected places,
with times consistent with the modeled constraints. The technical insight is to use an LLM
for interpreting preferences and Z3 for enforcing scheduling constraints, then reuse those
constraints when the user edits the calendar.

**Recommendation controls:** **Suggest other places** refreshes the choices. Previously saved
choice cards remain usable after reopening the trip while that proposal is current.
Choosing/skipping recommendations reuses saved candidates without another LLM call;
changing trip details or group preferences requires a fresh proposal.

**Optional mock mode:** Run `node mock-server/server.js` from the repository root and
`npm run start:mock` from `frontend` for canned API responses. This does not demonstrate
the real LLM + Z3 scenario above.

## Planning behavior

- The LLM returns the versioned schema in `backend/constraints.py`, never executable solver code.
- Z3 enforces trip dates, visit windows, durations, active hours, no overlap, estimated travel
  gaps, daily activity budget, daily activity count, must-do coverage, fixed appointments and ordering.
  Optional activities have preference scores; hard constraints are never silently relaxed.
- Existing locked stops are retained at their original times. Missing locked stops/anchors or
  incompatible constraints produce an explanation and a follow-up question instead of a fabricated plan.
- The result uses the existing frontend `Stop` schema. The normalized constraint problem and
  assumptions are saved as `trip.details.plannerConstraints` and `plannerWarnings` for later edits.
- Calendar drag/resize checks reuse the saved constraints without an LLM call, pin the user's
  edited times and locked stops, and minimize movement of the remaining visits. Accept/Revert uses
  the existing preview flow. Infeasible edits show the conflict and offer undo/keep controls.
- Times are destination-local, without timezone offsets. This version supports 1–14 days and
  at most 40 candidate activities, with same-day visits of 15–720 minutes. Each solver phase
  has a 5-second limit. If optimization times out after feasibility is established, the feasible
  schedule is returned with a warning; optimality is not claimed.

Hours, costs and travel times are **LLM estimates**, as shown in the calendar and event notes.
Z3 establishes consistency with those estimates, not real-world availability. Prices are normalized
to USD per person. The daily budget covers scheduled activities/food, excluding flights,
accommodation and transport expenses not explicitly represented as activities. A uniform travel
buffer is used; there is no live routing, booking or verified opening-hours integration. Dietary
suitability is estimated by the LLM rather than proven by Z3. Confirm details before booking.

## API and checks

Python API documentation: [Swagger UI](http://127.0.0.1:8000/docs).

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Server status, solver name, whether LLM settings are present (no provider call) |
| `GET /api/trip` | Explicit demo fixture for “Load Demo Trip” |
| `POST /api/chat` | Conversation → extra-place choices → explicit selection → Z3 itinerary, or clarification |
| `POST /api/itinerary/change` | Check/replan calendar edits using saved constraints |

Optional response fields are omitted when absent to match frontend Zod validation. Chat conflicts
return `status: 'gathering'` with no new itinerary; edit/input conflicts return HTTP 422 with an
explanation. Provider/configuration failures return HTTP 502/503. The development server uses
same-origin proxy requests. For production, configure your host's `/api` reverse proxy to Python;
Angular's development proxy is not bundled into static production output. This local API binds
to loopback; production authentication/deployment is outside this setup.

```sh
backend/.venv/bin/python -m pip install -r backend/requirements-dev.txt
backend/.venv/bin/python -m pytest backend/tests -q
cd frontend
npm test -- --watch=false
npm run build
```

Backend tests use synthetic constraint inputs and a stubbed LLM, so they require no API key or
paid provider calls. These are independent of any previous teammate's extraction contract.
