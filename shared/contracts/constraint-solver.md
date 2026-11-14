# Constraint solver v1 contract

This is a local, stateless computation service on port 3001. It never writes a trip or applies a proposal. Angular persists each authenticated member's own session in `trips/{tripId}/constraintSessions/{uid}` under Firebase rules. No privileged Firebase credentials are needed by the local solver. Production hosting requires authenticated/rate-limited access separately.

Canonical frontend schemas: `frontend/src/app/core/constraint-models.ts`.

- `GET /solver-api/health` -> `{ ok: true }`
- `GET /solver-api/catalog` -> SolverCatalog (fixed Paris fixtures, EUR **cents**, minutes, Europe/Paris)
- `POST /solver-api/solve` body: `{ trip: Trip, members: MemberConstraintSession[], catalogId: string, inputVersion: string, requestedEdits?: EditDiff[] }` -> SolverResponse.
- `inputVersion` fingerprints the full trip planning input, all members' current sessions and the catalog. Return it unchanged. Frontend must reject stale responses and transactionally check all planning inputs again before applying a proposal.
- Members must exactly cover trip.memberIds, be confirmed, and have matching constraint.ownerId. Missing members -> `incomplete`. Unsupported destinations, anchors or locked places -> `insufficient_data`.
- `budget_max` is integer cents per person per day, `day_start_min`/`day_end_max` integer destination-local minutes, `walking_max` integer walking minutes per day, `max_activities` integer non-food visits per day; their values are numeric. `interest` is a known tag string, `include_place`/`exclude_place` a catalog place ID. `hard` is explicit. An A/B preference is NOT automatically a hard requirement; indifferent adds no new preference.
- Respond with `status`, `proposal` (null unless sat), `conflicts: [{constraintId, ownerId, message}]`, `explanations: string[]`. SAT proposals contain `id, tripId, inputVersion, catalogId, summary, stops, warnings, memberScores: [{uid,score}]`.
- Use exact Stop schema. Existing locked stops must retain IDs, place, start and end; unsupported locked stops must fail explicitly. Existing trip.anchors need explicit catalog matching or an insufficient-data response. No external place lookup or coordinate replacement after solving.
- At most 3 days and 5 members, bounded catalog and solve timeout. Include ordered travel between adjacent visits and start/end base, opening hours, duration, per-day cost/walking/activity limits and meaningful nonempty daily schedules with food. Preserve all hard constraints; use normalized individual soft scores with explicit group objectives. Separate `unsat` from timeout/unknown.
- requestedEdits are user requests to evaluate, never automatic writes. Unknown/locked stop edits are rejected. The service may propose a repaired full schedule; only an explicit user Apply action persists it. Repair prioritizes keeping the requested edit when feasible and otherwise explains the alternative.
