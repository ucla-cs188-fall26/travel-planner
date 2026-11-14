# Local constraint solver

This bounded Paris demo generates a **proposal**. It has no Firebase credentials,
database connections, trip writes, or apply endpoint. Existing locked stops are
hard requirements. The browser must check `inputVersion` and require an explicit
Apply action before persisting a proposal.

From the repository root, install Python 3.12 dependencies once:

```sh
uv venv --python 3.12 solver-server/.venv
uv pip install --python solver-server/.venv/bin/python -r solver-server/requirements-dev.txt
```

Then start the server from this directory:

```sh
cd solver-server
.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 3001
```

Health, catalog and example solve:

```sh
curl http://127.0.0.1:3001/solver-api/health
curl http://127.0.0.1:3001/solver-api/catalog
curl --fail-with-body -H 'Content-Type: application/json' --data-binary @examples/solve-request.json http://127.0.0.1:3001/solver-api/solve
```

Run the checks from the repository root:

```sh
solver-server/.venv/bin/python -m pytest solver-server/tests -q
```

## Model and limits

- Fixed catalog `paris-sample-v1`: 12 places, one sample base, fixed route table,
  daily opening intervals, EUR **cents per person**, destination-local minutes
  in `Europe/Paris`. These are demonstration prices/hours/walking times, not
  current venue data or real Maps routes. There is no live place lookup.
- At most 3 days, 5 members and 5 visits per day. Each place is visited at most
  once per trip. Each day includes exactly one lunch (11:30–14:30), at least one
  non-food visit, and walking from/to the base between 08:00 and 22:00.
- Integer Z3 variables choose each day's ordered places and times. Hard
  constraints cover member limits, opening hours, minimum duration, adjacent
  travel, non-overlap, anchors and exact locked stops. Budget is each person's
  daily total of catalog visit/meal costs; it excludes accommodation and fares.
  Walking means travel walking, not time spent inside an attraction.
- Sessions must cover all trip members, be confirmed, contain the five
  version-1 answers exactly once, and own all their constraint records. An
  indifferent answer carries no inferred preference; a member with no soft
  records receives a neutral score of 100. Profile preferences and legacy trip
  overrides are not silently converted into hard constraints.
- Each soft record contributes one equal vote within its member. Daily bounds
  score only if satisfied on every day; an interest scores if any matching place
  is visited. Normalize each member's result to a 0–100 satisfaction ratio.
- Lexicographic objectives: maximize the number of exact requested edits kept,
  maximize the lowest individual ratio, maximize total individual ratios, keep
  existing unlocked visits, maximize non-food visits, then reduce walking and
  choose earlier times. All hard constraints outrank these objectives.
- `requestedEdits` must reference an existing, known, unlocked stop and its
  current original times. Unsupported or stale edits are rejected. If a request
  cannot be kept, a full alternative proposal is returned with a warning.
  Requested resizes can choose the requested duration or the catalog minimum.
  A duration shorter than the minimum, or otherwise infeasible, produces an
  explained alternative.

Feasibility and optimization are separate Z3 queries. The default total deadline
is 8 seconds (`SOLVER_TIMEOUT_MS` accepts 100–30000). A proven infeasible input
returns `unsat` with named constraint/member provenance. Its unsatisfiable core
is one conflicting set and is not guaranteed minimal. Undecided feasibility
returns `unknown`, never `unsat`. If feasibility is proven but optimization times
out, a model validated against every hard constraint may be returned as `sat`,
with an explicit warning that its objectives are not proven optimal.

Unknown anchors, locked places, conflicting locked coordinates, missing routes,
unsupported destinations/durations and catalog versions fail explicitly. The
sample cannot express repeated visits or locked transit/lodging outside its
catalog. Existing locked stops retain their original ID, place and exact times.

`inputVersion` is an opaque token echoed unchanged in SAT proposals. The server
is stateless and cannot know whether a caller's snapshot is still current; stale
proposal rejection belongs in the client transaction that applies it. The local
API is intentionally unauthenticated and serializes solver calls. Keep its bind
address on loopback; production hosting requires authenticated access and rate
limits.

The tests include a 32-case independent exhaustive tiny-catalog feasibility
oracle, fairness normalization, actual-route walking, budget units, locks,
hard/soft conflicts, indifferent input, stale versions/edits, missing data and
timeouts. The architecture takes inspiration from PLanet's declarative
specification → logical constraints → Z3 → decoded plans; travel constraints,
preference collection and group objectives are separate domain additions. See
[PLanet §4](https://arxiv.org/html/2505.09094v3#S4) and the official
[Z3 objective-priority documentation](https://microsoft.github.io/z3guide/docs/optimization/combiningobjectives/).
