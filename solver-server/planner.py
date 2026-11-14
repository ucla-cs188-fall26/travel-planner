"""Bounded, stateless Paris planner backed by genuine Z3 integer constraints.

All prices are integer EUR cents per person, times destination-local minutes.
The finite route table is part of the input fixture, not a Maps API estimate.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import date, datetime, timedelta
from functools import lru_cache
import json
import os
from pathlib import Path
import time
import unicodedata
from uuid import uuid4

import z3

from models import SolveRequest

CATALOG_PATH = Path(__file__).resolve().parent.parent / "shared/fixtures/solver-catalog.json"
NUMERIC_KINDS = {"budget_max", "day_start_min", "day_end_max", "walking_max", "max_activities"}
MAX_DAYS = 3
MAX_MEMBERS = 5
MAX_PLACES = 14
MAX_STOPS_PER_DAY = 5
DEFAULT_TIMEOUT_MS = 8_000
QUESTION_IDS = {"budget", "day-window", "walking", "pace", "interest"}


@lru_cache(maxsize=1)
def load_catalog():
    return json.loads(CATALOG_PATH.read_text())


def public_catalog(catalog):
    keys = ("id", "destination", "currency", "costUnit", "timezone", "description")
    place_keys = ("id", "title", "category", "durationMinutes", "cost", "openMinute", "closeMinute", "lat", "lng", "tags")
    return {**{key: catalog[key] for key in keys}, "places": [{key: p[key] for key in place_keys} for p in catalog["places"]]}


def response(status, explanations, conflicts=None, proposal=None):
    return {"status": status, "proposal": proposal, "conflicts": conflicts or [], "explanations": explanations}


def normalized(text):
    text = unicodedata.normalize("NFKD", text.casefold())
    return "".join(c for c in text if c.isalnum() and not unicodedata.combining(c))


def minute_time(text):
    value = datetime.fromisoformat(text)
    if value.tzinfo is not None or value.second or value.microsecond:
        raise ValueError("Use destination-local times rounded to whole minutes.")
    return value.date(), value.hour * 60 + value.minute


class InputProblem(Exception):
    def __init__(self, message, status="insufficient_data"):
        self.message, self.status = message, status


def prepare(request, catalog):
    trip = request.trip
    if request.catalogId != catalog["id"]:
        raise InputProblem("The requested catalog is unavailable; refresh the catalog before solving.")
    if not isinstance(trip.details.get("destination"), str) or normalized(trip.details["destination"]) not in {
        "paris", "parisfrance", "파리", "프랑스파리", "파리프랑스",
    }:
        raise InputProblem("This sample solver only supports Paris, France.")
    try:
        first, last = date.fromisoformat(trip.startDate), date.fromisoformat(trip.endDate)
    except ValueError:
        raise InputProblem("Trip dates must be valid YYYY-MM-DD dates.")
    days = (last - first).days + 1
    if not 1 <= days <= MAX_DAYS:
        raise InputProblem("This sample solver supports trips of 1–3 days only.")
    if not 1 <= len(trip.memberIds) <= MAX_MEMBERS or len(set(trip.memberIds)) != len(trip.memberIds):
        raise InputProblem("The trip must contain 1–5 distinct member IDs.")
    member_uids = [m.uid for m in request.members]
    if len(set(member_uids)) != len(member_uids) or set(member_uids) != set(trip.memberIds):
        raise InputProblem("Confirmed sessions must cover every current trip member exactly once.", "incomplete")
    if any(not m.confirmed for m in request.members):
        raise InputProblem("Every trip member must confirm their own constraints before solving.", "incomplete")
    for member in request.members:
        answers = [a.questionId for a in member.answers]
        if len(answers) != len(set(answers)) or set(answers) != QUESTION_IDS:
            raise InputProblem("Every confirmed member must answer each of the five version-1 questions exactly once; indifferent counts as an answer.", "incomplete")
    places = catalog["places"]
    if not 1 <= len(places) <= MAX_PLACES:
        raise InputProblem("The catalog exceeds the bounded sample solver size.")
    ids = {p["id"]: i + 1 for i, p in enumerate(places)}
    if len(ids) != len(places):
        raise InputProblem("Catalog place IDs must be unique.")
    by_name = {}
    for p in places:
        for name in [p["id"], p["title"], *p.get("aliases", [])]:
            by_name[normalized(name)] = ids[p["id"]]
    tags = {tag for p in places for tag in p["tags"]}
    limits = {"budget_max": (0, 1_000_000), "day_start_min": (0, 1439), "day_end_max": (1, 1440), "walking_max": (0, 1440), "max_activities": (0, 20)}
    for member in request.members:
        if len({c.id for c in member.constraints}) != len(member.constraints):
            raise InputProblem(f"Member {member.uid} has duplicate constraint IDs.")
        for c in member.constraints:
            if c.ownerId != member.uid:
                raise InputProblem("Every constraint ownerId must match the member session uid.", "incomplete")
            if c.kind in NUMERIC_KINDS:
                lo, hi = limits[c.kind]
                if not isinstance(c.value, (float, int)) or not float(c.value).is_integer() or not lo <= c.value <= hi:
                    raise InputProblem(f"{c.kind} must be an integer in [{lo}, {hi}], using cents/minutes/counts.")
            elif c.kind == "interest" and c.value not in tags:
                raise InputProblem(f"Unknown interest tag: {c.value}.")
            elif c.kind in {"include_place", "exclude_place"} and c.value not in ids:
                raise InputProblem(f"Unknown catalog place ID: {c.value}.")
    def find_place(stop):
        # Explicit IDs take precedence; an unknown explicit ID cannot silently
        # be relabeled just because a display name resembles a sample POI.
        if stop.place.placeId:
            return ids.get(stop.place.placeId)
        return by_name.get(normalized(stop.place.name))

    anchors = []
    for anchor in trip.anchors:
        idx = by_name.get(normalized(anchor))
        if idx is None:
            raise InputProblem(f'Anchor "{anchor}" has no exact match in the sample catalog; map it explicitly first.')
        anchors.append(idx)
    if len({s.id for s in trip.stops}) != len(trip.stops):
        raise InputProblem("Existing stop IDs must be unique.")
    existing = {}
    locked = {}
    for stop in trip.stops:
        idx = find_place(stop)
        if idx is not None:
            existing.setdefault(idx, stop)
        if not stop.locked:
            continue
        if idx is None:
            raise InputProblem(f'Locked stop "{stop.title}" has no exact match in the sample catalog.')
        if idx in locked:
            raise InputProblem("Repeated locked visits to the same place are not supported by this sample solver.")
        p = places[idx - 1]
        if (stop.category == "food") != (p["category"] == "food"):
            raise InputProblem(f'Locked stop "{stop.title}" has a food/non-food category inconsistent with the catalog.')
        if any(value is not None and abs(value - p[key]) > 0.0001 for key, value in [("lat", stop.place.lat), ("lng", stop.place.lng)]):
            raise InputProblem(f'Coordinates of locked stop "{stop.title}" differ from the catalog; no coordinates were replaced.')
        try:
            start_day, start = minute_time(stop.start)
            end_day, end = minute_time(stop.end)
        except ValueError as error:
            raise InputProblem(f'Locked stop "{stop.title}": {error}')
        day_index = (start_day - first).days
        if start_day != end_day or not 0 <= day_index < days or stop.day != day_index + 1 or end <= start:
            raise InputProblem(f'Locked stop "{stop.title}" must be a positive-duration visit within the trip dates.')
        locked[idx] = (stop, day_index, start, end)
    edits = []
    if len({e.stopId for e in request.requestedEdits}) != len(request.requestedEdits):
        raise InputProblem("Requested edits must reference each stop at most once.")
    stop_by_id = {s.id: s for s in trip.stops}
    for edit in request.requestedEdits:
        stop = stop_by_id.get(edit.stopId)
        if stop is None or stop.locked:
            raise InputProblem("Requested edits cannot reference unknown or locked stops.")
        idx = find_place(stop)
        if idx is None:
            raise InputProblem(f'Requested stop "{stop.title}" is outside the sample catalog.')
        if idx in locked:
            raise InputProblem("A requested edit cannot move or resize a place already represented by a locked visit.")
        try:
            if minute_time(edit.from_.start) != minute_time(stop.start) or minute_time(edit.from_.end) != minute_time(stop.end):
                raise InputProblem("An edit references an older version of a stop; refresh the trip before solving.")
            target_day, start = minute_time(edit.to.start)
            end_day, end = minute_time(edit.to.end)
        except ValueError as error:
            raise InputProblem(str(error))
        day_index = (target_day - first).days
        if end_day != target_day or not 0 <= day_index < days or end <= start:
            raise InputProblem("Requested edits must be positive-duration visits within the trip dates.")
        edits.append((edit, idx, day_index, start, end))
    nodes = [catalog["base"]["id"], *ids]
    routes = catalog.get("routes", {})
    for a in nodes:
        for b in nodes:
            value = routes.get(a, {}).get(b)
            if type(value) is not int or value < 0 or (a != b and value == 0):
                raise InputProblem(f"Missing/invalid walking route {a} → {b}; the solver will not assume zero travel.")
    return first, days, ids, anchors, existing, locked, edits


def solve(request: SolveRequest, catalog=None, timeout_ms=None):
    """Compute a proposal only. inputVersion is an opaque snapshot token echoed verbatim."""
    started = time.monotonic()
    catalog = catalog if catalog is not None else load_catalog()
    try:
        first, days, ids, anchors, existing, locked, edits = prepare(request, catalog)
    except InputProblem as error:
        return response(error.status, [error.message])
    if timeout_ms is None:
        try:
            timeout_ms = max(100, min(30_000, int(os.getenv("SOLVER_TIMEOUT_MS", str(DEFAULT_TIMEOUT_MS)))))
        except ValueError:
            timeout_ms = DEFAULT_TIMEOUT_MS
    deadline = started + timeout_ms / 1000
    if timeout_ms <= 0:
        return response("unknown", ["Solver deadline expired before feasibility could be determined."])

    places = catalog["places"]
    size = len(places)
    slots = min(MAX_STOPS_PER_DAY, catalog.get("maxStopsPerDay", MAX_STOPS_PER_DAY))
    solver = z3.Solver()
    hard = []
    provenance = {}
    def add(expr, constraint_id=None, owner="system", message=""):
        hard.append(expr)
        if constraint_id:
            symbol = z3.Bool(f"requirement_{len(provenance)}")
            provenance[str(symbol)] = {"constraintId": constraint_id, "ownerId": owner, "message": message}
            solver.assert_and_track(expr, symbol)
        else:
            solver.add(expr)
    # A dense constant array is a pure SMT lookup, including index 0 for no
    # visit/base. Unlike a sum of all pairwise distances, route_cost is used
    # only for visits that are actually adjacent in the selected order.
    def table(values):
        array = z3.K(z3.IntSort(), z3.IntVal(0))
        for index, value in enumerate(values):
            array = z3.Store(array, index, value)
        return array
    duration_values = [0] + [p["durationMinutes"] for p in places]
    for idx, (_, _, begin, end) in locked.items():
        duration_values[idx] = end - begin
    edited_durations = {}
    for _, idx, _, begin, end_time in edits:
        minimum = places[idx - 1]["durationMinutes"]
        if end_time - begin >= minimum:
            edited_durations.setdefault(idx, {minimum}).add(end_time - begin)
    for idx, alternatives in edited_durations.items():
        requested_duration = z3.Int(f"edited_duration_{idx}")
        add(z3.Or([requested_duration == value for value in sorted(alternatives)]))
        duration_values[idx] = requested_duration
    duration = table(duration_values)
    minimum_duration = table([0] + [p["durationMinutes"] for p in places])
    cost = table([0] + [p["cost"] for p in places])
    opening = table([0] + [p["openMinute"] for p in places])
    closing = table([1440] + [p["closeMinute"] for p in places])
    food = table([0] + [int(p["category"] == "food") for p in places])
    nodes = [catalog["base"]["id"], *ids]
    width = size + 1
    route = table([catalog["routes"][a][b] for a in nodes for b in nodes])
    def travel(a, b):
        return z3.Select(route, a * width + b)
    visit = [[z3.Int(f"place_{d}_{s}") for s in range(slots)] for d in range(days)]
    start = [[z3.Int(f"start_{d}_{s}") for s in range(slots)] for d in range(days)]
    end = [[start[d][s] + z3.Select(duration, visit[d][s]) for s in range(slots)] for d in range(days)]
    flat_visit = [p for row in visit for p in row]
    for p in flat_visit:
        add(z3.And(p >= 0, p <= size))
    for i, a in enumerate(flat_visit):
        for b in flat_visit[i + 1:]:
            add(z3.Or(a == 0, b == 0, a != b))
    daily_cost, daily_walk, daily_nonfood = [], [], []
    daily_depart, daily_return = [], []
    earliest = catalog.get("dailyStartMinute", 480)
    latest = catalog.get("dailyEndMinute", 1320)
    for d in range(days):
        row = visit[d]
        daily_cost.append(z3.Sum([z3.Select(cost, p) for p in row]))
        daily_nonfood.append(z3.Sum([z3.If(z3.And(p != 0, z3.Select(food, p) == 0), 1, 0) for p in row]))
        food_count = z3.Sum([z3.Select(food, p) for p in row])
        add(food_count == 1, f"system:lunch:{d + 1}", message=f"Day {d + 1} requires exactly one lunch between 11:30 and 14:30.")
        add(daily_nonfood[d] >= 1, f"system:activity:{d + 1}", message=f"Day {d + 1} requires at least one non-food visit.")
        for s, p in enumerate(row):
            active = p != 0
            add(z3.Implies(p == 0, start[d][s] == 0))
            add(z3.Implies(active, z3.And(start[d][s] >= 0, end[d][s] <= 1440)))
            add(z3.Implies(active, z3.And(start[d][s] >= z3.Select(opening, p), end[d][s] <= z3.Select(closing, p),
                                          z3.Select(duration, p) >= z3.Select(minimum_duration, p))),
                f"system:hours:{d + 1}:{s}", message=f"Day {d + 1} visits must fit catalog opening hours and minimum duration.")
            add(z3.Implies(z3.Select(food, p) == 1, z3.And(start[d][s] >= 690, end[d][s] <= 870)))
            if s > 0:
                add(z3.Implies(active, row[s - 1] != 0))
                add(z3.Implies(active, start[d][s] >= end[d][s - 1] + travel(row[s - 1], p)),
                    f"system:route:{d + 1}:{s}", message=f"Day {d + 1} needs enough travel time between adjacent visits; visits cannot overlap.")
        daily_depart.append(start[d][0] - travel(0, row[0]))
        last_return = z3.Sum([z3.If(z3.And(p != 0, row[s + 1] == 0) if s + 1 < slots else p != 0,
                                           end[d][s] + travel(p, 0), 0) for s, p in enumerate(row)])
        daily_return.append(last_return)
        add(z3.And(daily_depart[d] >= earliest, daily_return[d] <= latest),
            f"system:base:{d + 1}", message=f"Day {d + 1} must leave and return to the sample base between 08:00 and 22:00.")
        walking = travel(0, row[0])
        walking += z3.Sum([z3.If(row[s + 1] != 0, travel(row[s], row[s + 1]), 0) for s in range(slots - 1)])
        walking += z3.Sum([z3.If(z3.And(p != 0, row[s + 1] == 0) if s + 1 < slots else p != 0, travel(p, 0), 0) for s, p in enumerate(row)])
        daily_walk.append(walking)
    def included(indices):
        return z3.Or([p == idx for p in flat_visit for idx in indices])
    for idx in anchors:
        add(included([idx]), f"anchor:{places[idx - 1]['id']}", message=f"Trip anchor {places[idx - 1]['title']} must be included.")
    for idx, (stop, d, begin, finish) in locked.items():
        add(z3.Or([z3.And(visit[d][s] == idx, start[d][s] == begin, end[d][s] == finish) for s in range(slots)]),
            f"locked:{stop.id}", message=f'Locked stop "{stop.title}" must keep its exact day, place, start and end.')

    soft_by_member = {}
    all_records = {}
    def predicate(record):
        value = record.value
        if record.kind == "budget_max":
            return z3.And([x <= int(value) for x in daily_cost])
        if record.kind == "walking_max":
            return z3.And([x <= int(value) for x in daily_walk])
        if record.kind == "max_activities":
            return z3.And([x <= int(value) for x in daily_nonfood])
        if record.kind == "day_start_min":
            return z3.And([x >= int(value) for x in daily_depart])
        if record.kind == "day_end_max":
            return z3.And([x <= int(value) for x in daily_return])
        if record.kind == "interest":
            return included([i + 1 for i, p in enumerate(places) if value in p["tags"]])
        if record.kind == "include_place":
            return included([ids[value]])
        return z3.Not(included([ids[value]]))
    for member in request.members:
        soft = []
        for record in member.constraints:
            expr = predicate(record)
            all_records[(member.uid, record.id)] = expr
            if record.hard:
                add(expr, record.id, member.uid, f"{record.kind} = {record.value} (explicit hard requirement).")
            else:
                soft.append(expr)
        soft_by_member[member.uid] = soft
    def remaining():
        return max(0, int((deadline - time.monotonic()) * 1000))
    if remaining() <= 0:
        return response("unknown", ["Solver deadline expired while constructing the bounded model."])
    # Feasibility is checked independently of optimization. Only this call can
    # justify UNSAT and its named core. An undecided result is never UNSAT.
    # First try a small concrete ordering suggested by existing visits and
    # nearby sample places. It is merely a search hint: Z3 still checks every
    # hard constraint and chooses times. Failure of this restricted attempt is
    # never reported as UNSAT; we then search the complete bounded domain.
    excluded = {ids[c.value] for m in request.members for c in m.constraints if c.hard and c.kind == "exclude_place"}
    seed_rows = [[] for _ in range(days)]
    seed_seen = set()
    def seed_add(idx, day_index, hint):
        if idx not in seed_seen and len(seed_rows[day_index]) < slots and (idx not in excluded or idx in locked):
            seed_rows[day_index].append((hint, idx))
            seed_seen.add(idx)
    for idx, (_, day_index, begin, _) in locked.items():
        seed_add(idx, day_index, begin)
    for idx, stop in existing.items():
        if stop.locked:
            continue
        try:
            old_day, begin = minute_time(stop.start)
            day_index = (old_day - first).days
            if 0 <= day_index < days and not (places[idx - 1]["category"] == "food" and any(places[i - 1]["category"] == "food" for _, i in seed_rows[day_index])):
                seed_add(idx, day_index, begin)
        except ValueError:
            pass
    mandatory = list(anchors) + [ids[c.value] for m in request.members for c in m.constraints if c.hard and c.kind == "include_place"]
    for idx in mandatory:
        day_index = min(range(days), key=lambda d: len(seed_rows[d]))
        seed_add(idx, day_index, max(places[idx - 1]["openMinute"], 570))
    for d in range(days):
        for want_food in (False, True):
            if any((places[i - 1]["category"] == "food") == want_food for _, i in seed_rows[d]):
                continue
            candidates = [i + 1 for i, p in enumerate(places) if (p["category"] == "food") == want_food and i + 1 not in seed_seen and i + 1 not in excluded]
            if candidates:
                idx = min(candidates, key=lambda i: catalog["routes"]["base"][places[i - 1]["id"]] * 1000 + places[i - 1]["cost"])
                seed_add(idx, d, 750 if want_food else max(places[idx - 1]["openMinute"], 570))
    seed_result = None
    if all(2 <= len(row) <= slots for row in seed_rows) and remaining() > 0:
        solver.push()
        for d, row in enumerate(seed_rows):
            ordering = [idx for _, idx in sorted(row)]
            solver.add(*[visit[d][s] == (ordering[s] if s < len(ordering) else 0) for s in range(slots)])
        solver.set(timeout=max(1, min(500, remaining())))
        seed_result = solver.check()
        seed_model = solver.model() if seed_result == z3.sat else None
        solver.pop()
    if seed_result == z3.sat:
        result, feasible_model = z3.sat, seed_model
    else:
        solver.set(timeout=max(1, min(remaining(), int(timeout_ms * 0.7))))
        result = solver.check()
        feasible_model = solver.model() if result == z3.sat else None
    if result == z3.unsat:
        conflicts = [provenance[str(item)] for item in solver.unsat_core() if str(item) in provenance]
        return response("unsat", ["No schedule satisfies all hard requirements in this bounded sample catalog.",
                                  "These constraints form an unsatisfiable core, not necessarily the smallest or only conflicting set. Soften or edit a listed requirement and solve again."], conflicts)
    if result != z3.sat:
        return response("unknown", [f"Feasibility was not decided within the limit: {solver.reason_unknown()}. No proposal was generated."])
    model = feasible_model
    warnings = [catalog["description"], "This is a proposal only. Applying it requires an explicit user action."]
    if request.trip.overrides:
        warnings.append("Legacy trip overrides are not solver constraints; use confirmed member constraints to include those requirements.")
    if any((not stop.locked) and all(stop is not known for known in existing.values()) for stop in request.trip.stops):
        warnings.append("Some unlocked existing stops are outside this sample catalog and may be replaced in this proposal.")
    scores = {uid: z3.Sum([z3.If(expr, 1, 0) for expr in exprs]) / z3.RealVal(len(exprs)) if exprs else z3.RealVal(1)
              for uid, exprs in soft_by_member.items()}
    edit_predicates = [z3.Or([z3.And(visit[d][s] == idx, start[d][s] == begin, end[d][s] == finish) for s in range(slots)])
                       for _, idx, d, begin, finish in edits]
    optimizer = z3.Optimize()
    optimizer.add(*hard)
    optimizer.set(priority="lex", timeout=max(1, remaining()))
    if edit_predicates:
        optimizer.maximize(z3.Sum([z3.If(expr, 1, 0) for expr in edit_predicates]))
    minimum_score = z3.Real("minimum_member_score")
    optimizer.add(minimum_score >= 0, *[minimum_score <= score for score in scores.values()])
    optimizer.maximize(minimum_score)
    optimizer.maximize(z3.Sum(list(scores.values())))
    # Keep unchanged existing unlocked visits where possible after the explicit
    # preference objectives. All locked visits were hard constraints above.
    keep = []
    for idx, stop in existing.items():
        if stop.locked:
            continue
        try:
            old_date, old_start = minute_time(stop.start)
            old_end_date, old_end = minute_time(stop.end)
        except ValueError:
            continue
        d = (old_date - first).days
        if old_date == old_end_date and 0 <= d < days:
            keep.append(z3.Or([z3.And(visit[d][s] == idx, start[d][s] == old_start, end[d][s] == old_end) for s in range(slots)]))
    if keep:
        optimizer.maximize(z3.Sum([z3.If(expr, 1, 0) for expr in keep]))
    optimizer.maximize(z3.Sum(daily_nonfood))
    optimizer.minimize(z3.Sum(daily_walk) * 100_000 + z3.Sum([t for row in start for t in row]))
    optimized = False
    if remaining() > 0:
        optimization = optimizer.check()
        if optimization == z3.sat:
            model = optimizer.model()
            optimized = True
        else:
            # Optimize may expose a valid incumbent on timeout. Validate it
            # against *every* hard expression before returning it. If no valid
            # incumbent exists, the separately proven feasible model is safe.
            try:
                candidate = optimizer.model()
                if all(z3.is_true(candidate.eval(expr, model_completion=True)) for expr in hard):
                    model = candidate
            except z3.Z3Exception:
                pass
    if not optimized:
        warnings.append("Optimization reached its time limit. This schedule satisfies all hard constraints; group fairness, preference score and edit priority are not proven optimal.")
    if not all(z3.is_true(model.eval(expr, model_completion=True)) for expr in hard):
        return response("unknown", ["No fully validated model could be decoded; no proposal was generated."])
    for (edit, _, _, _, _), expr in zip(edits, edit_predicates):
        if not z3.is_true(model.eval(expr, model_completion=True)):
            warnings.append(f'Requested edit to "{edit.stopId}" could not be kept in this proposal. Review the alternative; nothing has been applied.')
    for member in request.members:
        for record in member.constraints:
            if not record.hard and not z3.is_true(model.eval(all_records[(member.uid, record.id)], model_completion=True)):
                warnings.append(f"Unmet soft preference for {member.uid}: {record.kind} = {record.value}.")
    proposal_id = f"proposal-{uuid4().hex}"
    reserved_ids = {stop.id for stop in request.trip.stops}
    emitted_ids = set()
    stops = []
    for d in range(days):
        for s in range(slots):
            idx = model.eval(visit[d][s]).as_long()
            if not idx:
                continue
            if idx in locked:
                stops.append(locked[idx][0].model_dump(exclude_none=True))
                emitted_ids.add(locked[idx][0].id)
                continue
            p = places[idx - 1]
            begin, finish = model.eval(start[d][s]).as_long(), model.eval(end[d][s]).as_long()
            def local_time(minutes):
                return datetime.combine(first + timedelta(days=d), datetime.min.time()).replace(hour=minutes // 60, minute=minutes % 60).isoformat(timespec="seconds")
            old = existing.get(idx)
            if old:
                stop_id = old.id
            else:
                stop_id = f"{proposal_id}-{p['id']}"
                while stop_id in reserved_ids or stop_id in emitted_ids:
                    stop_id = f"{proposal_id}-{p['id']}-{uuid4().hex}"
            emitted_ids.add(stop_id)
            stops.append({"id": stop_id, "day": d + 1, "title": p["title"],
                          "start": local_time(begin), "end": local_time(finish),
                          "place": {"name": p["title"], "placeId": p["id"], "lat": p["lat"], "lng": p["lng"]},
                          "category": p["category"], "locked": False, "priceRange": f"€{p['cost'] / 100:.2f} per person (sample)",
                          "notes": "Fixed demonstration catalog; travel between adjacent visits and the sample base is included."})
    member_scores = [{"uid": member.uid, "score": round(100 * sum(z3.is_true(model.eval(expr, model_completion=True)) for expr in soft_by_member[member.uid]) / len(soft_by_member[member.uid]), 2)
                      if soft_by_member[member.uid] else 100.0} for member in request.members]
    explanations = ["All explicit hard constraints and locked stops are satisfied by a Z3 model.",
                    "Objectives, in priority order: keep requested edits, maximize the lowest member soft-preference satisfaction ratio, maximize the total normalized ratio, keep existing visits, maximize non-food visits, then reduce walking and choose earlier times.",
                    "Each soft record has equal weight within its member. A record with daily limits scores only if it holds on every day; interests score if visited at least once. Members with no soft preferences have a neutral score of 100. Indifferent answers add no new preferences."]
    for d in range(days):
        explanations.append(f"Day {d + 1}: €{model.eval(daily_cost[d]).as_long() / 100:.2f} per person, {model.eval(daily_walk[d]).as_long()} walking minutes including the base, {model.eval(daily_nonfood[d]).as_long()} non-food visits.")
    proposal = {"id": proposal_id, "tripId": request.trip.id, "inputVersion": request.inputVersion,
                "catalogId": catalog["id"], "summary": f"Paris sample proposal: {days} day(s), {len(stops)} visits. Review before applying.",
                "stops": stops, "warnings": warnings, "memberScores": member_scores}
    return response("sat", explanations, proposal=proposal)
