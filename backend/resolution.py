"""Step 6.1: turn a solver conflict into a two-option choice the group settles.

RILEY OWNS THIS FILE.

When the Z3 solver can't satisfy every hard constraint, it reports which ones
clash (PlanningError.details). This module:
  1. proposes concrete fixes (raise the budget, extend the day, skip a place...),
  2. TESTS each fix with the real solver, keeping only ones that work,
  3. picks two that settle the conflict in different ways,
  4. shows them as a comparison card (Qwen only writes the wording),
  5. when someone taps "I pick: ...", records the group's decision in
     trip.details['groupDecisions'] and solves again.

Decisions persist in trip.details, so later re-plans keep honoring them.
Anchors are never offered for removal: anchors outrank preferences.
"""
import uuid
from dataclasses import dataclass, field

from pydantic import BaseModel, ValidationError

from . import llm
from .constraints import Hours, PlanningConstraints
from .schemas import ChatRequest, Comparison, ComparisonOption, GroupPreferences, Trip
from .solver import PlanningError, prepare_constraints, solve

PICK_PREFIX = 'I pick:'
PACE_CAPS = {'relaxed': 3, 'balanced': 5, 'packed': 7}
TRIAL_TIMEOUT_MS = 2000


# ---------- Applying the group's decisions before solving ----------

def merged_decisions(old: dict | None, new: dict) -> dict:
    """Combine a new decision with earlier ones. Skipped places accumulate."""
    result = {**(old or {}), **new}
    if (old or {}).get('skip') or new.get('skip'):
        result['skip'] = sorted(set((old or {}).get('skip', [])) | set(new.get('skip', [])))
    return result


def apply_decisions(raw: PlanningConstraints, trip: Trip) -> tuple[PlanningConstraints, Trip]:
    """Make the group's earlier decisions win over profile preferences.

    prepare_constraints narrows the plan to the strictest of the LLM's values and
    the group's preferences, so a decision is written into BOTH: the raw
    constraints and trip.overrides (which prepare_constraints applies last).
    """
    decisions = trip.details.get('groupDecisions') or {}
    if not decisions:
        return raw, trip
    data = raw.model_dump(mode='json')
    overrides = dict(trip.overrides)

    if decisions.get('budgetPerDay') is not None:
        data['dailyBudgetCents'] = round(float(decisions['budgetPerDay']) * 100)
        overrides['budgetPerDay'] = decisions['budgetPerDay']
    if decisions.get('activeHours'):
        data['activeHours'] = decisions['activeHours']
        overrides['activeHours'] = decisions['activeHours']
    if decisions.get('maxActivitiesPerDay'):
        n = int(decisions['maxActivitiesPerDay'])
        data['maxActivitiesPerDay'] = n
        overrides['pace'] = next((p for p, cap in PACE_CAPS.items() if cap >= n), None)
    skip = set(decisions.get('skip', []))
    if skip:
        def skipped(a):
            return (a['id'] in skip or a['title'] in skip) and not a['anchorIndices'] and not a['fixedStart']
        data['activities'] = [a for a in data['activities'] if not skipped(a)]
        kept = {a['id'] for a in data['activities']}
        data['before'] = [e for e in data['before'] if e['beforeId'] in kept and e['afterId'] in kept]

    return PlanningConstraints.model_validate(data), trip.model_copy(update={'overrides': overrides})


def prepare(raw: PlanningConstraints, trip: Trip, group: GroupPreferences | None) -> PlanningConstraints:
    """prepare_constraints, with the group's decisions applied first."""
    raw, trip = apply_decisions(raw, trip)
    return prepare_constraints(raw, trip, group)


# ---------- Finding fixes that actually work ----------

@dataclass
class Option:
    kind: str      
    decision: dict 
    title: str
    problem: PlanningConstraints | None = None 
    stops: list = field(default_factory=list)
    member: str | None = None


def _with_decision(trip: Trip, decision: dict) -> Trip:
    details = {**trip.details, 'groupDecisions': merged_decisions(trip.details.get('groupDecisions'), decision)}
    return trip.model_copy(update={'details': details})


def _trial(raw, trip, group, decision):
    """Solve with a decision applied. Returns (problem, stops) or None if it still fails."""
    trial_trip = _with_decision(trip, decision)
    try:
        problem = prepare(raw, trial_trip, group)
        stops, _ = solve(trial_trip, problem, timeout_ms=TRIAL_TIMEOUT_MS)
        return problem, stops
    except (PlanningError, ValidationError):
        return None


def _min_budget(raw, trip, group, current_cents):
    """Smallest whole-dollar daily budget that makes the plan work, or None.

    Binary search in whole dollars: `low` always fails, `high` always works.
    """
    low = (current_cents or 0) // 100
    high = -(-max(current_cents or 0, sum(a.costCents for a in raw.activities)) // 100)
    if _trial(raw, trip, group, {'budgetPerDay': high}) is None:
        return None
    while high - low > 1:
        mid = (low + high) // 2
        if _trial(raw, trip, group, {'budgetPerDay': mid}):
            high = mid
        else:
            low = mid
    return high


def _min_count(raw, trip, group, current):
    for n in range(current + 1, 8):
        if _trial(raw, trip, group, {'maxActivitiesPerDay': n}):
            return n
    return None


def _covering_hours(problem: PlanningConstraints, activity_id: str) -> dict | None:
    """Active hours just wide enough to fit this activity's earliest visit window."""
    activity = next((a for a in problem.activities if a.id == activity_id), None)
    if activity is None:
        return None
    window = min(activity.windows, key=lambda w: w.start)
    start = min(problem.activeHours.start, window.start)
    end = max(problem.activeHours.end, window.end)
    try:
        return Hours(start=start, end=end).model_dump()
    except ValidationError:
        return None


def candidate_options(exc: PlanningError, raw: PlanningConstraints, trip: Trip,
                      group: GroupPreferences | None) -> list[Option]:
    """Every fix the solver confirms would work, most useful first."""
    try:
        current = prepare(raw, trip, group)
    except PlanningError:
        current = None

    options: list[Option] = []
    tried: set[str] = set()

    def consider(kind, decision, title, member=None):
        key = repr(sorted(decision.items()))
        if key in tried:
            return
        tried.add(key)
        result = _trial(raw, trip, group, decision)
        if result:
            options.append(Option(kind, decision, title, *result, member=member))

    if group and any('overlapping active hours' in c for c in exc.conflicts):
        for m in group.members:
            hours = m.preferences.activeHours
            if hours:
                h = hours.model_dump()
                consider('member_hours', {'activeHours': h},
                         f"Use {m.name}'s hours ({h['start']}–{h['end']})", member=m.name)
        return options

    if current is None:
        return options

    activities = {a.id: a for a in current.activities}
    types = {d.get('type') for d in exc.details}

    if 'budget' in types:
        dollars = _min_budget(raw, trip, group, current.dailyBudgetCents)
        if dollars is not None:
            consider('budget', {'budgetPerDay': dollars}, f'Raise the budget to ${dollars}/day')
    if 'daily_count' in types:
        n = _min_count(raw, trip, group, current.maxActivitiesPerDay)
        if n is not None:
            consider('count', {'maxActivitiesPerDay': n}, f'Allow {n} places a day')
    for d in exc.details:
        if d.get('type') == 'hours':
            hours = _covering_hours(current, d['activity'])
            if hours:
                consider('hours', {'activeHours': hours},
                         f"Extend the day to {hours['start']}–{hours['end']}")

    involved = []
    for d in exc.details:
        ids = d.get('activities') or ([d['activity']] if d.get('activity') else [])
        ids += [d[k] for k in ('before', 'after') if d.get(k)]
        involved += [i for i in ids if i not in involved]
    for activity_id in involved:
        a = activities.get(activity_id)
        if a and not a.anchorIndices and a.fixedStart is None:
            consider('skip', {'skip': [a.id]}, f'Skip {a.title}')

    return options


def choose_two(options: list[Option]) -> list[Option] | None:
    """Two options that settle the conflict in different ways."""
    relax = [o for o in options if o.kind != 'skip']
    skip = [o for o in options if o.kind == 'skip']
    if relax and skip:
        return [relax[0], skip[0]]
    return options[:2] if len(options) >= 2 else None


# ---------- Building the comparison card ----------

def _member_budget(m):
    return m.preferences.budgetPerDay


def _suits(option: Option, other: Option, group: GroupPreferences | None) -> list[str]:
    """Members whose own profile preferences agree with this option."""
    if not group:
        return []
    names = []
    for m in group.members:
        p = m.preferences
        if option.kind == 'member_hours':
            ok = m.name == option.member
        elif option.kind == 'budget':
            ok = p.budgetPerDay is None or p.budgetPerDay >= option.decision['budgetPerDay']
        elif option.kind == 'hours':
            h = option.decision['activeHours']
            ok = p.activeHours is None or (p.activeHours.start <= h['start'] and p.activeHours.end >= h['end'])
        elif option.kind == 'count':
            ok = PACE_CAPS.get(p.pace, 12) >= option.decision['maxActivitiesPerDay']
        else: 
            ok = other.kind != 'skip' and m.name not in _suits(other, option, group)
        if ok:
            names.append(m.name)
    return names


def _facts(option: Option) -> tuple[str, str, str]:
    """(cost, travelTime, location) strings for the card, taken from the solved plan."""
    p = option.problem
    cost = f'Up to ${p.dailyBudgetCents / 100:.0f}/person/day' if p.dailyBudgetCents is not None else 'No daily budget cap'
    hours = f'{p.activeHours.start}–{p.activeHours.end} each day, up to {p.maxActivitiesPerDay} places a day'
    if option.kind == 'skip':
        location = f'Skips {option.title.removeprefix("Skip ")}; {len(option.stops)} stops planned'
    else:
        location = f'Keeps every must-do; {len(option.stops)} stops planned'
    return cost, hours, location


class _Wording(BaseModel):
    reply: str
    prompt: str


def _wording(exc: PlanningError, pair: list[Option]) -> _Wording:
    """Qwen writes the friendly text; a template is used if Qwen is unavailable."""
    readable = [c for c, d in zip(exc.conflicts, exc.details or [{}] * len(exc.conflicts))
                if d.get('type') != 'valid']
    fallback = _Wording(
        reply="Your group's preferences can't all fit in one schedule:\n"
              + '\n'.join(f'- {c}' for c in readable[:4]) + '\nPick the option you prefer.',
        prompt='How should we settle this?')
    try:
        return llm.ask_json(
            'A group trip planner found that these requirements clash:\n'
            + '\n'.join(f'- {c}' for c in readable[:6])
            + f'\n\nThe group will choose between:\nA: {pair[0].title}\nB: {pair[1].title}\n\n'
            'Write "reply": two short, friendly sentences explaining the clash in plain words '
            '(no field names or jargon). Write "prompt": one short question asking the group to choose. '
            'Do not invent new options or numbers.', _Wording)
    except llm.LLMError:
        return fallback


def build_comparison(exc: PlanningError, raw: PlanningConstraints, trip: Trip,
                     group: GroupPreferences | None, stage: str):
    """Returns (reply, comparison, pendingResolution) or None if two working options don't exist."""
    if exc.timeout:
        return None
    pair = choose_two(candidate_options(exc, raw, trip, group))
    if not pair:
        return None
    options = []
    for option, other, oid in ((pair[0], pair[1], 'a'), (pair[1], pair[0], 'b')):
        cost, hours, location = _facts(option)
        options.append(ComparisonOption(id=oid, title=option.title, cost=cost, travelTime=hours,
                                        location=location, suits=_suits(option, other, group)))
    wording = _wording(exc, pair)
    pending = {'id': str(uuid.uuid4()), 'stage': stage,
               'raw': raw.model_dump(mode='json', exclude_none=True),
               'options': {o.title: o.decision for o in pair}}
    comparison = Comparison(id=pending['id'], prompt=wording.prompt, options=tuple(options))
    return wording.reply, comparison, pending


# ---------- Handling "I pick: ..." ----------

def picked_decision(request: ChatRequest):
    """If this message picks an option from the pending comparison, return (pending, decision)."""
    pending = request.trip.details.get('pendingResolution')
    if not pending or not request.message.startswith(PICK_PREFIX):
        return None
    title = request.message.removeprefix(PICK_PREFIX).strip()
    decision = (pending.get('options') or {}).get(title)
    return (pending, decision) if decision is not None else None