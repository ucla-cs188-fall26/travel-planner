"""Independent schedule checks, domain edge cases and a tiny exhaustive oracle."""
from copy import deepcopy
from datetime import datetime
from itertools import permutations, product

import pytest
from fastapi.testclient import TestClient

from app import app
from models import SolveRequest
from planner import QUESTION_IDS, load_catalog, minute_time, solve


def session(uid="alice", constraints=None):
    return {"uid": uid, "schemaVersion": 1, "revision": 1, "confirmed": True,
            "answers": [{"questionId": q, "questionVersion": 1, "choice": "indifferent", "createdAt": 0} for q in sorted(QUESTION_IDS)],
            "constraints": constraints or [], "updatedAt": 0}


def constraint(kind, value, hard=True, uid="alice", id=None):
    return {"id": id or f"{uid}:{kind}:{value}", "ownerId": uid, "kind": kind, "value": value, "hard": hard}


def request(constraints=None, **trip_changes):
    trip = {"id": "trip-test", "name": "Sample Paris", "ownerId": "alice", "memberIds": ["alice"],
            "startDate": "2026-11-20", "endDate": "2026-11-20", "details": {"destination": "Paris"}, "stops": [], "anchors": []}
    trip.update(trip_changes)
    return SolveRequest.model_validate({"trip": trip, "members": [session(constraints=constraints)],
                                        "catalogId": "paris-sample-v1", "inputVersion": "opaque-snapshot-version"})


@pytest.fixture
def tiny():
    data = deepcopy(load_catalog())
    data["places"] = [
        {"id": "food", "title": "Sample lunch", "category": "food", "durationMinutes": 45, "cost": 1000, "openMinute": 690, "closeMinute": 870, "lat": 48.86, "lng": 2.33, "tags": ["food"]},
        {"id": "art", "title": "Sample art", "category": "sight", "durationMinutes": 60, "cost": 1000, "openMinute": 540, "closeMinute": 1080, "lat": 48.86, "lng": 2.33, "tags": ["art"]},
        {"id": "park", "title": "Sample park", "category": "free", "durationMinutes": 45, "cost": 0, "openMinute": 480, "closeMinute": 1200, "lat": 48.86, "lng": 2.33, "tags": ["nature"]},
    ]
    nodes = ["base", "food", "art", "park"]
    data["routes"] = {a: {b: 0 if a == b else 5 for b in nodes} for a in nodes}
    data["maxStopsPerDay"] = 3
    return data


def assert_valid_stops(result, catalog, req):
    assert result["status"] == "sat", result
    proposal = result["proposal"]
    assert proposal["inputVersion"] == req.inputVersion
    assert proposal["tripId"] == req.trip.id
    catalog_by_id = {p["id"]: p for p in catalog["places"]}
    ids = [s["id"] for s in proposal["stops"]]
    assert len(ids) == len(set(ids))
    days = (datetime.fromisoformat(req.trip.endDate) - datetime.fromisoformat(req.trip.startDate)).days + 1
    for d in range(1, days + 1):
        row = [s for s in proposal["stops"] if s["day"] == d]
        assert sum(s["category"] == "food" for s in row) == 1
        assert any(s["category"] != "food" for s in row)
        previous_end, previous_id = 480, "base"
        for stop in row:
            place = catalog_by_id[stop["place"]["placeId"]]
            start = minute_time(stop["start"])[1]
            end = minute_time(stop["end"])[1]
            assert start >= previous_end + catalog["routes"][previous_id][place["id"]]
            assert place["openMinute"] <= start < end <= place["closeMinute"]
            assert end - start >= place["durationMinutes"]
            previous_end, previous_id = end, place["id"]
        assert previous_end + catalog["routes"][previous_id]["base"] <= 1320


def test_api_health_catalog_and_invalid_request():
    with TestClient(app) as client:
        assert client.get("/solver-api/health").json() == {"ok": True}
        catalog = client.get("/solver-api/catalog").json()
        assert catalog["id"] == "paris-sample-v1"
        assert catalog["costUnit"] == "cents per person"
        assert "routes" not in catalog
        assert client.post("/solver-api/solve", json={}).status_code == 422
        assert client.post("/solver-api/apply", json={}).status_code == 404


def test_neutral_plan_is_nonempty_cents_and_side_effect_free(tiny):
    req = request([constraint("budget_max", 1000), constraint("walking_max", 15)])
    before = req.model_dump()
    result = solve(req, tiny, 1000)
    assert_valid_stops(result, tiny, req)
    assert req.model_dump() == before
    assert {s["place"]["placeId"] for s in result["proposal"]["stops"]} == {"food", "park"}
    assert result["proposal"]["memberScores"] == [{"uid": "alice", "score": 100}]
    assert all(value is not None for s in result["proposal"]["stops"] for value in s.values())


def test_actual_adjacency_not_all_pairs(tiny):
    # Two visits cost three actual route edges, not every possible pair.
    good = solve(request([constraint("walking_max", 15)]), tiny, 1000)
    assert good["status"] == "sat"
    assert len(good["proposal"]["stops"]) == 2
    bad = solve(request([constraint("walking_max", 14)]), tiny, 1000)
    assert bad["status"] == "unsat"


def test_core_retains_distinct_member_provenance(tiny):
    req = request([constraint("include_place", "art", id="must-art")])
    req.trip.memberIds.append("bob")
    from models import MemberSession
    req.members.append(MemberSession.model_validate(session("bob", [constraint("exclude_place", "art", uid="bob", id="no-art")])))
    result = solve(req, tiny, 1000)
    assert result["status"] == "unsat"
    assert result["proposal"] is None
    assert {(c["constraintId"], c["ownerId"]) for c in result["conflicts"]} >= {("must-art", "alice"), ("no-art", "bob")}


def test_soft_conflict_does_not_turn_into_unsat_and_indifferent_is_neutral(tiny):
    req = request([constraint("include_place", "art", False), constraint("exclude_place", "art", False)])
    req.trip.memberIds.append("bob")
    from models import MemberSession
    req.members.append(MemberSession.model_validate(session("bob")))
    result = solve(req, tiny, 1000)
    assert result["status"] == "sat"
    assert result["proposal"]["memberScores"] == [{"uid": "alice", "score": 50}, {"uid": "bob", "score": 100}]


def test_minimum_member_ratio_beats_raw_record_count(tiny):
    # One visit only. Art satisfies 3/4 Alice records and 0/1 Bob records;
    # park satisfies 1/4 Alice records and 1/1 Bob records. Max-min chooses park
    # even though raw satisfied record counts would prefer art (3 vs 2).
    req = request([constraint("max_activities", 1)] + [constraint("include_place", "art", False, id=f"art-{i}") for i in range(3)] + [constraint("include_place", "park", False, id="park-a")])
    req.trip.memberIds.append("bob")
    from models import MemberSession
    req.members.append(MemberSession.model_validate(session("bob", [constraint("include_place", "park", False, uid="bob")])))
    result = solve(req, tiny, 2000)
    assert result["status"] == "sat"
    assert {s["place"]["placeId"] for s in result["proposal"]["stops"]} == {"food", "park"}
    assert result["proposal"]["memberScores"] == [{"uid": "alice", "score": 25}, {"uid": "bob", "score": 100}]


def test_locked_stops_copy_exactly_and_never_move(tiny):
    locked = {"id": "original-lock", "day": 1, "title": "My museum reservation", "start": "2026-11-20T10:00", "end": "2026-11-20T11:30",
              "place": {"name": "Sample art", "placeId": "art"}, "category": "sight", "locked": True, "notes": "Keep reservation"}
    req = request(stops=[locked])
    result = solve(req, tiny, 1000)
    assert result["status"] == "sat"
    assert next(s for s in result["proposal"]["stops"] if s["id"] == "original-lock") == locked
    req.members[0].constraints.append(constraint_record("exclude_place", "art"))
    assert solve(req, tiny, 1000)["status"] == "unsat"


def constraint_record(kind, value):
    from models import ConstraintRecord
    return ConstraintRecord.model_validate(constraint(kind, value))


def test_overlapping_locks_unsat_and_too_short_lock_unsat(tiny):
    a = {"id": "a", "day": 1, "title": "Art", "start": "2026-11-20T12:00", "end": "2026-11-20T13:00", "place": {"name": "Sample art"}, "locked": True}
    b = {**a, "id": "b", "title": "Park", "place": {"name": "Sample park"}}
    assert solve(request(stops=[a, b]), tiny, 1000)["status"] == "unsat"
    a["end"] = "2026-11-20T12:10"
    assert solve(request(stops=[a]), tiny, 1000)["status"] == "unsat"


@pytest.mark.parametrize("mutation, status", [
    (lambda r: setattr(r.trip, "memberIds", ["alice", "missing"]), "incomplete"),
    (lambda r: setattr(r.members[0], "confirmed", False), "incomplete"),
    (lambda r: r.members[0].answers.pop(), "incomplete"),
    (lambda r: r.members.append(r.members[0].model_copy()), "incomplete"),
    (lambda r: setattr(r.trip, "details", {"destination": "Tokyo"}), "insufficient_data"),
    (lambda r: setattr(r.trip, "endDate", "2026-11-23"), "insufficient_data"),
    (lambda r: setattr(r.trip, "anchors", ["unknown place"]), "insufficient_data"),
    (lambda r: setattr(r, "catalogId", "stale-catalog"), "insufficient_data"),
    (lambda r: r.members[0].constraints.append(constraint_record("include_place", "unknown")), "insufficient_data"),
    (lambda r: r.members[0].constraints.extend([constraint_record("walking_max", 30), constraint_record("walking_max", 30)]), "insufficient_data"),
])
def test_invalid_domain_input_is_explicit(tiny, mutation, status):
    req = request()
    mutation(req)
    result = solve(req, tiny, 1000)
    assert result["status"] == status
    assert result["proposal"] is None


def test_unknown_lock_and_missing_route_are_not_silently_replaced(tiny):
    lock = {"id": "x", "day": 1, "title": "Unknown", "start": "2026-11-20T10:00", "end": "2026-11-20T11:00", "place": {"name": "Unknown"}, "locked": True}
    assert solve(request(stops=[lock]), tiny, 1000)["status"] == "insufficient_data"
    del tiny["routes"]["art"]["park"]
    assert solve(request(), tiny, 1000)["status"] == "insufficient_data"


def test_expired_deadline_is_unknown_not_unsat(tiny):
    result = solve(request(), tiny, timeout_ms=0)
    assert result["status"] == "unknown"
    assert result["proposal"] is None
    assert result["conflicts"] == []


def test_requested_edit_priority_and_stale_edit_rejection(tiny):
    stop = {"id": "old", "day": 1, "title": "Art", "start": "2026-11-20T10:00", "end": "2026-11-20T11:00", "place": {"name": "Sample art"}, "locked": False}
    req = request([constraint("exclude_place", "art", False)], stops=[stop])
    from models import EditDiff
    edit = EditDiff.model_validate({"stopId": "old", "from": {"start": stop["start"], "end": stop["end"]},
                                    "to": {"start": "2026-11-20T15:00", "end": "2026-11-20T16:00"}})
    req.requestedEdits = [edit]
    result = solve(req, tiny, 2000)
    assert result["status"] == "sat"
    assert next(s for s in result["proposal"]["stops"] if s["id"] == "old")["start"] == "2026-11-20T15:00:00"
    # Hard exclusions outrank requested edits; the proposal warns and preserves
    # a valid full schedule without writing a change back into the request.
    req.members[0].constraints[0].hard = True
    alternative = solve(req, tiny, 1000)
    assert alternative["status"] == "sat"
    assert any("Requested edit" in warning for warning in alternative["proposal"]["warnings"])
    assert req.trip.stops[0].start == stop["start"]
    req.requestedEdits[0].from_.start = "2026-11-20T09:59"
    assert solve(req, tiny, 1000)["status"] == "insufficient_data"
    req.requestedEdits[0].from_.start = stop["start"]
    req.trip.stops[0].locked = True
    assert solve(req, tiny, 1000)["status"] == "insufficient_data"


def test_requested_resize_respects_minimum_and_uses_feasible_requested_duration(tiny):
    stop = {"id": "old", "day": 1, "title": "Art", "start": "2026-11-20T10:00", "end": "2026-11-20T11:00", "place": {"name": "Sample art"}, "locked": False}
    req = request(stops=[stop])
    from models import EditDiff
    req.requestedEdits = [EditDiff.model_validate({"stopId": "old", "from": {"start": stop["start"], "end": stop["end"]},
                                                  "to": {"start": "2026-11-20T15:00", "end": "2026-11-20T16:30"}})]
    result = solve(req, tiny, 2000)
    assert result["status"] == "sat"
    changed = next(s for s in result["proposal"]["stops"] if s["id"] == "old")
    assert changed["start"] == "2026-11-20T15:00:00"
    assert changed["end"] == "2026-11-20T16:30:00"
    req.requestedEdits[0].to.end = "2026-11-20T15:30"
    alternative = solve(req, tiny, 1000)
    assert alternative["status"] == "sat"
    assert any("Requested edit" in warning for warning in alternative["proposal"]["warnings"])
    actual = next(s for s in alternative["proposal"]["stops"] if s["id"] == "old")
    assert minute_time(actual["end"])[1] - minute_time(actual["start"])[1] >= 60


def test_new_proposal_ids_cannot_collide_with_retained_stop_id(tiny):
    stop = {"id": "proposal-art", "day": 1, "title": "Park", "start": "2026-11-20T10:00", "end": "2026-11-20T10:45", "place": {"name": "Sample park"}, "locked": False}
    req = request([constraint("include_place", "art"), constraint("include_place", "park")], stops=[stop])
    result = solve(req, tiny, 1000)
    assert_valid_stops(result, tiny, req)
    assert "proposal-art" in {s["id"] for s in result["proposal"]["stops"]}


def oracle_feasible(catalog, budget, walk, max_activities):
    """Exhaust all visit subsets/orders and earliest feasible starts, no SMT.

    Earliest-start scheduling is complete here: fixed durations, nonnegative
    fixed travel, one opening/closing interval and no exact-time locks.
    """
    places = catalog["places"]
    by_id = {p["id"]: p for p in places}
    for count in (2, 3):
        for ordering in permutations(by_id, count):
            row = [by_id[pid] for pid in ordering]
            if sum(p["category"] == "food" for p in row) != 1 or count - 1 > max_activities:
                continue
            if sum(p["cost"] for p in row) > budget:
                continue
            nodes = ["base", *ordering, "base"]
            if sum(catalog["routes"][a][b] for a, b in zip(nodes, nodes[1:])) > walk:
                continue
            time, previous, valid = 480, "base", True
            for p in row:
                time = max(time + catalog["routes"][previous][p["id"]], p["openMinute"])
                time += p["durationMinutes"]
                if time > p["closeMinute"]:
                    valid = False
                previous = p["id"]
            if valid and time + catalog["routes"][previous]["base"] <= 1320:
                return True
    return False


def test_z3_feasibility_matches_exhaustive_tiny_oracle(tiny):
    for budget, walk, activities in product((999, 1000, 1999, 2000), (14, 15, 19, 20), (1, 2)):
        result = solve(request([constraint("budget_max", budget), constraint("walking_max", walk), constraint("max_activities", activities)]), tiny, 1000)
        expected = oracle_feasible(tiny, budget, walk, activities)
        assert result["status"] == ("sat" if expected else "unsat"), (budget, walk, activities, result)


def test_three_day_real_sample_locks_survive():
    import json
    from pathlib import Path
    trip = json.loads((Path(__file__).resolve().parents[2] / "shared/fixtures/mock-trip.json").read_text())
    trip["memberIds"], trip["ownerId"] = ["alice"], "alice"
    req = request(**trip)
    result = solve(req, timeout_ms=2500)
    assert result["status"] == "sat", result
    by_id = {s["id"]: s for s in result["proposal"]["stops"]}
    for stop in trip["stops"]:
        if stop.get("locked"):
            assert by_id[stop["id"]] == stop
    assert {s["day"] for s in result["proposal"]["stops"]} == {1, 2, 3}
