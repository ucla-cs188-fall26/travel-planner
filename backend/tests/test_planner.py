"""Synthetic test inputs: these are not captures of a teammate's LLM output."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from backend import llm, planner
from backend.constraints import Extraction, PlanningConstraints
from backend.main import app
from backend.schemas import GroupPreferences, Trip
from backend.solver import PlanningError, prepare_constraints, solve


@pytest.fixture
def trip():
    return Trip(id='test-trip', name='Test Paris', ownerId='test', memberIds=['test'],
                startDate='2026-11-20', endDate='2026-11-21', details={'destination': 'Paris'},
                anchors=['Museum'])


def activity(sid, *, required=False, anchor=False, cost=1000):
    return {'id': sid, 'title': sid, 'place': {'name': sid}, 'durationMinutes': 60,
            'windows': [{'date': d, 'start': '09:00', 'end': '18:00'}
                        for d in ['2026-11-20', '2026-11-21']],
            'required': required, 'anchorIndices': [0] if anchor else [],
            'costCents': cost, 'preferenceScore': 10}


@pytest.fixture
def problem():
    return PlanningConstraints.model_validate({
        'dailyBudgetCents': 2500, 'travelMinutes': 30, 'maxActivitiesPerDay': 2,
        'activities': [activity('Museum', anchor=True), activity('Lunch'),
                       activity('Park'), activity('Gallery')],
        'before': [{'beforeId': 'Museum', 'afterId': 'Gallery', 'gapMinutes': 30}],
    })


@pytest.fixture
def client():
    return TestClient(app)


def request_body(trip):
    return {'message': 'Please plan these two days.', 'trip': trip.model_dump(mode='json', exclude_none=True),
            'groupPreferences': None, 'recentMessages': []}


def test_schedule_covers_days_anchors_budget_order_and_travel(trip, problem):
    plan, warnings = solve(trip, prepare_constraints(problem, trip))
    assert len(plan) == 4
    assert {s.day for s in plan} == {1, 2}
    assert next(s for s in plan if s.id == 'Museum').locked
    for day in (1, 2):
        stops = sorted((s for s in plan if s.day == day), key=lambda s: s.start)
        assert sum(next(a.costCents for a in problem.activities if a.id == s.id) for s in stops) <= 2500
        for first, second in zip(stops, stops[1:]):
            assert (datetime.fromisoformat(second.start) - datetime.fromisoformat(first.end)).total_seconds() >= 1800
        assert all(s.start[11:16] >= '09:00' and s.end[11:16] <= '18:00' for s in stops)
    by_id = {s.id: s for s in plan}
    assert by_id['Museum'].end < by_id['Gallery'].start
    assert 'estimates' in warnings[0]


def test_unsat_never_relaxes_required_overlap(trip, problem):
    data = problem.model_dump(mode='json')
    for a in data['activities'][:2]:
        a.update(required=True, fixedStart='2026-11-20T09:00:00')
    with pytest.raises(PlanningError) as error:
        solve(trip, PlanningConstraints.model_validate(data))
    assert any('overlap' in c for c in error.value.conflicts)


def test_fixed_appointments_cannot_be_dropped_to_meet_budget(trip, problem):
    data = problem.model_dump(mode='json')
    data['activities'][1].update(fixedStart='2026-11-20T12:00:00', costCents=100000)
    with pytest.raises(PlanningError):
        solve(trip, PlanningConstraints.model_validate(data))


def test_group_budget_is_authoritative(trip, problem):
    group = GroupPreferences.model_validate({'merged': {'budgetPerDay': 0}})
    prepared = prepare_constraints(problem, trip, group)
    assert prepared.dailyBudgetCents == 0
    with pytest.raises(PlanningError):
        solve(trip, prepared)


def test_group_hours_and_pace_are_authoritative(trip, problem):
    group = GroupPreferences.model_validate({'merged': {'activeHours': {'start': '10:00', 'end': '17:00'},
                                                        'pace': 'relaxed'}})
    prepared = prepare_constraints(problem, trip, group)
    assert prepared.activeHours.start == '10:00'
    assert prepared.activeHours.end == '17:00'
    assert prepared.maxActivitiesPerDay <= 3


def test_missing_anchor_and_out_of_trip_windows_are_rejected(trip, problem):
    data = problem.model_dump(mode='json')
    data['activities'][0]['anchorIndices'] = []
    with pytest.raises(PlanningError, match='Missing required visits'):
        prepare_constraints(PlanningConstraints.model_validate(data), trip)
    data = problem.model_dump(mode='json')
    data['activities'][0]['windows'][0]['date'] = '2026-12-01'
    with pytest.raises(PlanningError, match='outside the trip'):
        prepare_constraints(PlanningConstraints.model_validate(data), trip)


def test_locked_stop_is_preserved_and_cannot_be_omitted(trip, problem):
    stops, _ = solve(trip, problem)
    trip.stops = stops
    locked = next(s for s in stops if s.locked)
    prepared = prepare_constraints(problem, trip)
    result, _ = solve(trip, prepared)
    found = next(s for s in result if s.id == locked.id)
    assert (found.start, found.end, found.place) == (locked.start, locked.end, locked.place)
    data = problem.model_dump(mode='json')
    data['activities'] = [a for a in data['activities'] if a['id'] != locked.id]
    data['before'] = []
    with pytest.raises(PlanningError, match='omitted locked event'):
        prepare_constraints(PlanningConstraints.model_validate(data), trip)


def test_solver_is_thread_safe(trip, problem):
    with ThreadPoolExecutor(max_workers=4) as pool:
        plans = list(pool.map(lambda _: solve(trip, problem)[0], range(4)))
    assert all(len(plan) == 4 for plan in plans)


def test_chat_returns_frontend_contract_and_saved_constraints(client, monkeypatch, trip, problem):
    monkeypatch.setattr(planner, 'extract', lambda _: Extraction(status='ready', reply='Here are the candidates.',
                                                               destination='Paris', constraints=problem))
    response = client.post('/api/chat', json=request_body(trip))
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['status'] == 'gathering'
    assert 'itinerary' not in data
    assert {s['id'] for s in data['suggestions']} == {'Lunch', 'Park', 'Gallery'}
    trip.details.update(data['extracted'])
    body = request_body(trip)
    body['suggestionDecision'] = {'proposalId': data['proposalId'], 'action': 'accept',
                                  'acceptedIds': ['Lunch', 'Park', 'Gallery']}
    monkeypatch.setattr(planner, 'extract', lambda _: pytest.fail('Acceptance must reuse the exact proposed constraints'))
    response = client.post('/api/chat', json=body)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['status'] == 'ready' and len(data['itinerary']) == 4
    assert data['extracted']['plannerConstraints']['version'] == 1
    assert data['warnings']
    # Optional nested fields must be omitted: Zod's optional() rejects explicit nulls.
    assert 'lat' not in data['itinerary'][0]['place']
    assert 'sourceUrl' not in data['itinerary'][0]
    assert 'pendingProposal' in data['extracted'] and data['extracted']['pendingProposal'] is None


def get_proposal(client, monkeypatch, trip, problem):
    monkeypatch.setattr(planner, 'extract', lambda _: Extraction(status='ready', reply='Choose some more places.', constraints=problem))
    response = client.post('/api/chat', json=request_body(trip))
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['suggestions']
    trip.details.update(data['extracted'])
    monkeypatch.setattr(planner, 'extract', lambda _: pytest.fail('Do not make another LLM call for a selection'))
    return data


def accept_body(trip, proposal, ids, action='accept'):
    body = request_body(trip)
    body['suggestionDecision'] = {'proposalId': proposal['proposalId'], 'action': action, 'acceptedIds': ids}
    return body


def test_only_accepted_extras_are_included_as_required_visits(client, monkeypatch, trip, problem):
    proposal = get_proposal(client, monkeypatch, trip, problem)
    response = client.post('/api/chat', json=accept_body(trip, proposal, ['Park']))
    assert response.status_code == 200
    data = response.json()
    assert data['status'] == 'ready'
    assert {s['id'] for s in data['itinerary']} == {'Museum', 'Park'}
    saved = data['extracted']['plannerConstraints']
    assert next(a for a in saved['activities'] if a['id'] == 'Park')['required']
    assert data['extracted']['acceptedSuggestionIds'] == ['Park']


def test_acceptance_conflict_does_not_silently_drop_the_chosen_place(client, monkeypatch, trip, problem):
    problem.activities[-1].costCents = 100000
    proposal = get_proposal(client, monkeypatch, trip, problem)
    response = client.post('/api/chat', json=accept_body(trip, proposal, ['Gallery']))
    assert response.status_code == 200
    assert response.json()['status'] == 'gathering'
    assert 'itinerary' not in response.json()
    assert 'pendingProposal' not in response.json()['extracted']
    retry = client.post('/api/chat', json=accept_body(trip, proposal, ['Park']))
    assert retry.json()['status'] == 'ready'


def test_skip_excludes_unaccepted_places(client, monkeypatch, trip, problem):
    problem.minActivitiesPerDay = 0
    proposal = get_proposal(client, monkeypatch, trip, problem)
    assert proposal['canSkipSuggestions']
    response = client.post('/api/chat', json=accept_body(trip, proposal, [], action='skip'))
    assert response.json()['status'] == 'ready'
    assert [s['id'] for s in response.json()['itinerary']] == ['Museum']


@pytest.mark.parametrize('ids', [['not-offered'], ['Park', 'Park'], []])
def test_invalid_selections_are_rejected(client, monkeypatch, trip, problem, ids):
    proposal = get_proposal(client, monkeypatch, trip, problem)
    assert client.post('/api/chat', json=accept_body(trip, proposal, ids)).status_code == 422


def test_outdated_choices_and_changed_preferences_are_rejected(client, monkeypatch, trip, problem):
    proposal = get_proposal(client, monkeypatch, trip, problem)
    body = accept_body(trip, {**proposal, 'proposalId': 'old-proposal'}, ['Park'])
    assert client.post('/api/chat', json=body).status_code == 422
    trip.overrides = {'budgetPerDay': 5}
    response = client.post('/api/chat', json=accept_body(trip, proposal, ['Park']))
    assert response.status_code == 422
    assert 'changed' in response.json()['detail']


def test_anchor_copies_are_not_offered_as_new_places(client, monkeypatch, trip, problem):
    duplicate = activity('duplicate')
    duplicate['place'] = {'name': 'Museum'}
    problem.activities.append(type(problem.activities[0]).model_validate(duplicate))
    proposal = get_proposal(client, monkeypatch, trip, problem)
    assert 'duplicate' not in {p['id'] for p in proposal['suggestions']}


def test_first_extraction_requires_additional_places():
    from backend.constraints import InitialExtraction
    from pydantic import ValidationError
    with pytest.raises(ValidationError, match='optional real places'):
        InitialExtraction(status='ready', reply='Candidates', constraints=PlanningConstraints.model_validate({
            'activities': [activity('Museum', anchor=True)]}))


def test_chat_unsat_returns_question_without_itinerary(client, monkeypatch, trip, problem):
    data = problem.model_dump(mode='json')
    data['dailyBudgetCents'] = 0
    impossible = PlanningConstraints.model_validate(data)
    monkeypatch.setattr(planner, 'extract', lambda _: Extraction(status='ready', reply='Candidates.', constraints=impossible))
    response = client.post('/api/chat', json=request_body(trip))
    assert response.status_code == 200
    assert response.json()['status'] == 'gathering'
    assert response.json()['question']['field'] == 'planningClarification'
    assert 'itinerary' not in response.json()


def test_chat_followup_skips_solver(client, monkeypatch, trip):
    monkeypatch.setattr(planner, 'extract', lambda _: Extraction.model_validate({
        'status': 'gathering', 'reply': 'Which city?',
        'question': {'id': 'destination', 'field': 'destination', 'type': 'text', 'prompt': 'Which city?'}}))
    response = client.post('/api/chat', json=request_body(trip))
    assert response.json()['question']['prompt'] == 'Which city?'
    assert 'itinerary' not in response.json()


def test_solver_timeout_is_not_reported_as_unsatisfiable(client, monkeypatch, trip, problem):
    monkeypatch.setattr(planner, 'extract', lambda _: Extraction(status='ready', reply='Candidates.', constraints=problem))
    def timeout(*_):
        raise PlanningError(['Solver time limit.'], timeout=True)
    monkeypatch.setattr(planner, 'solve', timeout)
    response = client.post('/api/chat', json=request_body(trip))
    assert response.status_code == 200
    assert response.json()['question']['id'] == 'planning-timeout'
    assert 'itinerary' not in response.json()


def test_edit_pins_user_move_and_preserves_other_visits(client, monkeypatch, trip, problem):
    monkeypatch.setattr(llm, 'ask_json', lambda *_: pytest.fail('Calendar edits must use saved constraints, not LLM calls'))
    trip.stops, _ = solve(trip, problem)
    trip.details['plannerConstraints'] = problem.model_dump(mode='json')
    # Move the last nonlocked event later within its valid window.
    stop = sorted((s for s in trip.stops if not s.locked), key=lambda s: s.start)[-1]
    original = {'start': stop.start, 'end': stop.end}
    stop.start = stop.start[:11] + '16:00:00'
    stop.end = stop.end[:11] + '17:00:00'
    diff = {'stopId': stop.id, 'from': original, 'to': {'start': stop.start, 'end': stop.end}}
    response = client.post('/api/itinerary/change', json={'trip': trip.model_dump(mode='json'), 'diff': [diff]})
    assert response.status_code == 200, response.text
    result = {s['id']: s for s in response.json()['changes']}
    assert set(result) == {s.id for s in trip.stops}
    assert result[stop.id]['start'] == stop.start
    for locked in (s for s in trip.stops if s.locked):
        assert result[locked.id]['start'] == locked.start


def test_edit_conflict_returns_explanation(client, trip, problem):
    trip.stops, _ = solve(trip, problem)
    trip.details['plannerConstraints'] = problem.model_dump(mode='json')
    stop = next(s for s in trip.stops if not s.locked)
    before = {'start': stop.start, 'end': stop.end}
    stop.start, stop.end = '2026-11-20T23:00:00', '2026-11-21T00:00:00'
    response = client.post('/api/itinerary/change', json={
        'trip': trip.model_dump(mode='json'),
        'diff': [{'stopId': stop.id, 'from': before, 'to': {'start': stop.start, 'end': stop.end}}]})
    assert response.status_code == 422
    assert response.json()['detail']


def test_llm_failure_and_unconfigured_health_are_safe(client, monkeypatch, trip):
    monkeypatch.setattr(llm, 'configured', lambda: False)
    assert client.get('/api/health').json()['llmConfigured'] is False
    def fail(*_):
        raise llm.LLMError('Set API_KEY and MODEL in backend/.env before planning.')
    monkeypatch.setattr(planner, 'extract', fail)
    response = client.post('/api/chat', json=request_body(trip))
    assert response.status_code == 503
    assert 'API_KEY' in response.json()['detail']


def test_invalid_request_and_long_trip_fail_before_llm(client, monkeypatch, trip):
    monkeypatch.setattr(planner, 'extract', lambda _: pytest.fail('Do not call LLM for invalid dates'))
    assert client.post('/api/chat', json={'message': 'test'}).status_code == 422
    trip.endDate = '2027-01-01'
    assert client.post('/api/chat', json=request_body(trip)).status_code == 422


def test_ask_json_validates_and_retries(monkeypatch):
    answers = iter(['not json', '{"status":"gathering","reply":"City?","question":'
                               '{"id":"city","field":"destination","type":"text","prompt":"City?"}}'])
    monkeypatch.setattr(llm, 'ask_text', lambda *_, **__: next(answers))
    assert llm.ask_json('test', Extraction).status == 'gathering'
    monkeypatch.setattr(llm, 'ask_text', lambda *_, **__: 'invalid')
    with pytest.raises(llm.LLMError, match='invalid planning constraints'):
        llm.ask_json('test', Extraction)
