# Travel Planner

Angular frontend, Firebase Auth/Firestore storage, and a Python FastAPI backend that uses an
OpenAI-compatible LLM to extract constraints and Z3 to schedule activities.

```text
Browser → Angular :4200 → /api proxy → FastAPI :8000
                                      ├─ llm.py → configured LLM provider
                                      └─ validated constraints → Z3 → Stop[] → calendar
Browser → Firebase Auth / Firestore and Google Maps / Places
```

## Run locally

From the repository root (Python 3.11+):

```sh
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
```

If `backend/.env` does not exist, create it using `backend/.env.example`. Set `API_KEY`,
`BASE_URL`, and `MODEL` for your provider. The backend loads this file independently of
the shell's working directory. Keys are never placed in the frontend or returned by health checks.

```sh
backend/.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
```

In another terminal:

```sh
cd frontend
npm install
npm start
```

Open [the app](http://localhost:4200). Keep your existing Firebase/Google Maps configuration
in `frontend/src/environments/environment.ts` and `environment.development.ts`; an example
is included in that directory. `apiBaseUrl: '/api'` routes requests through the development
proxy to Python. To use the Express mock instead, run `node mock-server/server.js` from
the repository root and `npm run start:mock` from `frontend`.

Sign in, create a trip (destination, dates, must-do places), and describe your preferences
in chat. For example: “Plan a relaxed day in Paris, 09:00–18:00, with Luxembourg Gardens
and French food. USD 60 per person for today's activities and meals.” The backend may
ask follow-up questions. Before the first schedule, it offers additional places beyond your must-dos
as choice cards in chat. Select the places you want and choose **Build with selected places**;
the accepted places become required visits alongside the anchors. Unselected suggestions are excluded.
If the selection conflicts with the time/budget constraints, the planner explains the conflict and keeps
the choices available for another selection. A feasible plan is saved in Firestore and appears in the
calendar immediately. Maps coordinates are enriched afterward without blocking the schedule.
When the trip has no scheduled activities, **Suggest first itinerary** starts this recommendation flow
using the trip details and any preferences currently typed in the composer. **Suggest other places**
refreshes the choices. Previously saved choice cards remain usable after reopening the trip while that
proposal is current. Choosing/skipping recommendations reuses the saved candidates without another LLM
call; changing trip details or group preferences requires a fresh proposal.
Click an activity on the calendar or map to open its details in a modal. Unlocked activities
have editable date/start/end inputs; **Save time** checks the new times using the same
Accept/Revert flow as dragging an event. Unlock a locked activity in the modal before editing it.
Warnings/estimates and schedule-change summaries are available through compact buttons that open
scrollable dialogs. Actual errors and their recovery controls remain visible inline.

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
