"""Schedule validated activity data with Z3 integer/Boolean constraints."""
from datetime import date, datetime, time, timedelta
from decimal import Decimal

import z3
from pydantic import ValidationError

from .constraints import Hours, PlanningConstraints
from .schemas import GroupPreferences, Stop, Trip

ESTIMATE_NOTICE = ('Opening hours, activity costs (USD per person), and travel times are LLM estimates, '
                   'not live verified data. The budget covers scheduled activities only, excluding flights and accommodation.')


class PlanningError(ValueError):
    """conflicts: error explanation. details: matching machine-readable tags"""
    def __init__(self, conflicts: list[str], *, timeout: bool = False, details: list[dict] | None = None):
        super().__init__('; '.join(conflicts))
        self.conflicts = conflicts
        self.timeout = timeout
        self.details = details or []


def trip_dates(trip: Trip) -> list[date]:
    try:
        start, end = date.fromisoformat(trip.startDate), date.fromisoformat(trip.endDate)
    except ValueError as exc:
        raise PlanningError(['Set valid trip dates in YYYY-MM-DD format.']) from exc
    days = (end - start).days + 1
    if not 1 <= days <= 14:
        raise PlanningError(['This planner supports trips of 1–14 days. Adjust the trip dates.'])
    if len(trip.anchors) > 40:
        raise PlanningError(['This planner supports up to 40 must-do places.'])
    return [start + timedelta(days=i) for i in range(days)]


def minutes(clock: str) -> int:
    h, m = clock.split(':')
    return int(h) * 60 + int(m)


def local_start(value: str) -> datetime:
    try:
        dt = datetime.fromisoformat(value)
    except ValueError as exc:
        raise PlanningError(['A calendar event has an invalid date/time.']) from exc
    if dt.tzinfo is not None or dt.second or dt.microsecond:
        raise PlanningError(['Calendar events must use local times on whole minutes without a timezone offset.'])
    return dt


def prepare_constraints(raw: PlanningConstraints, trip: Trip,
                        group: GroupPreferences | None = None) -> PlanningConstraints:
    """Apply authoritative group preferences and preserve locked calendar events."""
    dates = trip_dates(trip)
    data = raw.model_dump(mode='json')
    prefs = group.merged.model_dump(exclude_none=True) if group else {}
    prefs.update(trip.overrides)
    if group and any(c.field == 'activeHours' for c in group.conflicts) and not prefs.get('activeHours'):
        raise PlanningError(['The group has no overlapping active hours. Agree on active hours first.'])
    if prefs.get('activeHours'):
        try:
            hours = Hours.model_validate(prefs['activeHours'])
        except ValidationError as exc:
            raise PlanningError(['Set valid active hours that start and end on the same day.']) from exc
        # LLM windows may be narrower, but cannot widen the group's availability.
        data['activeHours'] = {
            'start': max(raw.activeHours.start, hours.start),
            'end': min(raw.activeHours.end, hours.end),
        }
    if prefs.get('budgetPerDay') is not None:
        try:
            budget = Decimal(str(prefs['budgetPerDay']))
            if not budget.is_finite() or not 0 <= budget <= 1_000_000:
                raise ValueError('Invalid budget')
            cents = int(budget * 100)
        except (ValueError, ArithmeticError) as exc:
            raise PlanningError(['Set a nonnegative daily budget in USD per person.']) from exc
        data['dailyBudgetCents'] = min(raw.dailyBudgetCents, cents) if raw.dailyBudgetCents is not None else cents
    cap = {'relaxed': 3, 'balanced': 5, 'packed': 7}.get(prefs.get('pace'), 12)
    data['maxActivitiesPerDay'] = min(raw.maxActivitiesPerDay, cap)

    by_id = {a['id']: a for a in data['activities']}
    for stop in trip.stops:
        if not stop.locked:
            continue
        start, end = local_start(stop.start), local_start(stop.end)
        duration = int((end - start).total_seconds() // 60)
        if start.date() != end.date() or not 15 <= duration <= 720:
            raise PlanningError([f'Locked event "{stop.title}" must be a same-day activity of 15–720 minutes.'])
        existing = by_id.get(stop.id)
        if existing is None:
            # A missing price must not silently count as free against a budget.
            raise PlanningError([f'The LLM omitted locked event "{stop.title}". Ask it to include that event and its estimated cost.'])
        existing.update(id=stop.id, title=stop.title, place=stop.place.model_dump(exclude_none=True),
                        category=stop.category, durationMinutes=duration, required=True,
                        fixedStart=start.isoformat())

    try:
        prepared = PlanningConstraints.model_validate(data)
    except ValidationError as exc:
        raise PlanningError(['Planning constraints conflict with the group active hours or daily activity limit.']) from exc
    covered = set()
    for a in prepared.activities:
        if any(i < 0 or i >= len(trip.anchors) for i in a.anchorIndices):
            raise PlanningError([f'Invalid must-do reference for "{a.title}".'])
        covered.update(a.anchorIndices)
        if any(w.date not in dates for w in a.windows):
            raise PlanningError([f'The visit windows for "{a.title}" fall outside the trip dates.'])
    missing = [name for i, name in enumerate(trip.anchors) if i not in covered]
    if missing:
        raise PlanningError(['Missing required visits: ' + ', '.join(missing)])
    return prepared


def solve(trip: Trip, problem: PlanningConstraints, *, pinned: dict[str, tuple[str, str]] | None = None,
          preserve_all: bool = False, timeout_ms: int = 5000) -> tuple[list[Stop], list[str]]:
    dates = trip_dates(trip)
    pinned = pinned or {}
    activities = problem.activities
    ctx = z3.Context()
    selected = [z3.Bool(f'visit_{i}', ctx=ctx) for i in range(len(activities))]
    day = [z3.Int(f'day_{i}', ctx=ctx) for i in range(len(activities))]
    start = [z3.Int(f'start_{i}', ctx=ctx) for i in range(len(activities))]
    hard: list[tuple[object, str, dict]] = []
    # Anchor supremacy: a must-do may break a group preference (hours, budget, pace),
    # if there is no way around it. These track each break so the optimizer can minimize them before anything else.
    hour_breaks: list[tuple[int, object]] = []      # (activity index, minutes outside active hours)
    budget_breaks: list[tuple[date, object]] = []   # (day, cents over budget)
    pace_breaks: list[tuple[date, object, object]] = []  # (day, extra places, count)

    def must_do(a) -> bool:
        return bool(a.anchorIndices) or a.fixedStart is not None

    def require(expression, explanation, **info):
        hard.append((expression, explanation, info))

    old = {s.id: s for s in trip.stops}
    ids = {a.id: i for i, a in enumerate(activities)}
    if any(key not in ids for key in pinned):
        raise PlanningError(['An edited event is missing from the saved planning constraints. Generate a new plan first.'])
    for i, a in enumerate(activities):
        visit, d, s = selected[i], day[i], start[i]
        require(z3.And(d >= 0, d < len(dates), s >= 0, s < 1440), f'Valid trip date/time for "{a.title}".',
                type='valid', activity=a.id)
        if a.required or a.fixedStart is not None or (preserve_all and a.id in old) or a.id in pinned:
            require(visit, f'Required visit: {a.title}.', type='required', activity=a.id)
        allowed = [z3.And(d == (w.date - dates[0]).days,
                          s >= minutes(w.start), s + a.durationMinutes <= minutes(w.end)) for w in a.windows]
        require(z3.Implies(visit, z3.Or(*allowed)), f'Opening/visit windows for "{a.title}".',
                type='window', activity=a.id)
        open_at, close_at = minutes(problem.activeHours.start), minutes(problem.activeHours.end)
        if must_do(a) or a.id in pinned:
            early = z3.If(s < open_at, open_at - s, 0)
            late = z3.If(s + a.durationMinutes > close_at, s + a.durationMinutes - close_at, 0)
            hour_breaks.append((i, z3.If(visit, early + late, 0)))
        else:
            require(z3.Implies(visit, z3.And(s >= open_at, s + a.durationMinutes <= close_at)),
                    f'Active hours for "{a.title}" ({problem.activeHours.start}–{problem.activeHours.end}).',
                    type='hours', activity=a.id)
        fixed = a.fixedStart
        if a.id in pinned:
            pstart, pend = map(local_start, pinned[a.id])
            if int((pend - pstart).total_seconds() // 60) != a.durationMinutes:
                raise PlanningError([f'The edited duration for "{a.title}" does not match its activity duration.'])
            if fixed and fixed != pstart:
                raise PlanningError([f'"{a.title}" has a fixed appointment and cannot be moved.'])
            fixed = pstart
        if fixed:
            require(z3.Implies(visit, z3.And(d == (fixed.date() - dates[0]).days,
                                            s == fixed.hour * 60 + fixed.minute)),
                    f'Fixed appointment: {a.title} at {fixed.isoformat(timespec="minutes")}.',
                    type='fixed', activity=a.id)

    for i, a in enumerate(activities):
        for j in range(i + 1, len(activities)):
            b = activities[j]
            require(z3.Implies(z3.And(selected[i], selected[j], day[i] == day[j]),
                               z3.Or(start[i] + a.durationMinutes + problem.travelMinutes <= start[j],
                                     start[j] + b.durationMinutes + problem.travelMinutes <= start[i])),
                    f'No overlap + {problem.travelMinutes} min travel: {a.title} / {b.title}.',
                    type='overlap', activities=[a.id, b.id])
    for d, dt in enumerate(dates):
        on_day = [z3.And(selected[i], day[i] == d) for i in range(len(activities))]
        count = z3.Sum([z3.If(x, 1, 0) for x in on_day])
        extra = z3.Int(f'extra_places_{d}', ctx=ctx)
        must_dos_today = z3.Sum([z3.If(x, 1, 0) for x, a in zip(on_day, activities) if must_do(a)] or [z3.IntVal(0, ctx)])
        require(z3.And(count >= problem.minActivitiesPerDay, extra >= 0, extra <= must_dos_today,
                       count <= problem.maxActivitiesPerDay + extra),
                f'{dt}: {problem.minActivitiesPerDay}–{problem.maxActivitiesPerDay} activities required.',
                type='daily_count', date=str(dt))
        pace_breaks.append((dt, extra, count))
        if problem.dailyBudgetCents is not None:
            cost = z3.Sum([z3.If(x, a.costCents, 0) for x, a in zip(on_day, activities)])
            over = z3.Int(f'over_budget_{d}', ctx=ctx)
            must_do_cost = z3.Sum([z3.If(x, a.costCents, 0) for x, a in zip(on_day, activities) if must_do(a)]
                                  or [z3.IntVal(0, ctx)])
            needed = z3.If(must_do_cost > problem.dailyBudgetCents, must_do_cost - problem.dailyBudgetCents, 0)
            require(z3.And(over >= 0, over <= needed, cost <= problem.dailyBudgetCents + over),
                    f'{dt}: daily activity budget USD {problem.dailyBudgetCents / 100:.2f}/person.',
                    type='budget', date=str(dt))
            budget_breaks.append((dt, over))
    for anchor_index, name in enumerate(trip.anchors):
        require(z3.Or(*[selected[i] for i, a in enumerate(activities) if anchor_index in a.anchorIndices]),
                f'Must-do visit: {name}.', type='anchor', index=anchor_index)
    for edge in problem.before:
        i, j = ids[edge.beforeId], ids[edge.afterId]
        require(z3.Implies(z3.And(selected[i], selected[j]),
                           day[i] * 1440 + start[i] + activities[i].durationMinutes + edge.gapMinutes
                           <= day[j] * 1440 + start[j]),
                f'Visit {activities[i].title} before {activities[j].title}.',
                type='order', before=edge.beforeId, after=edge.afterId)

    checker = z3.Solver(ctx=ctx)
    checker.set(timeout=timeout_ms)
    for i, (expr, *_) in enumerate(hard):
        checker.assert_and_track(expr, z3.Bool(f'constraint_{i}', ctx=ctx))
    status = checker.check()
    if status == z3.unsat:
        indices = [int(str(label).removeprefix('constraint_')) for label in checker.unsat_core()]
        raise PlanningError([hard[i][1] for i in indices][:12], details=[hard[i][2] for i in indices][:12])
    if status != z3.sat:
        raise PlanningError(['The solver reached its time limit. Try fewer candidates or a shorter trip.'], timeout=True)

    model = checker.model()
    optimizer = z3.Optimize(ctx=ctx)
    optimizer.set(timeout=timeout_ms)
    optimizer.add(*[expr for expr, *_ in hard])
    breaks = ([z3.If(m > 0, 1, 0) for _, m in hour_breaks] + [z3.If(o > 0, 1, 0) for _, o in budget_breaks]
              + [z3.If(e > 0, 1, 0) for _, e, _ in pace_breaks])
    if breaks:
        optimizer.minimize(z3.Sum(breaks))
    for terms in ([o for _, o in budget_breaks], [m for _, m in hour_breaks], [e for _, e, _ in pace_breaks]):
        if terms:
            optimizer.minimize(z3.Sum(terms))
    if preserve_all:
        movement = []
        for i, a in enumerate(activities):
            if a.id in old:
                previous = local_start(old[a.id].start)
                offset = (previous.date() - dates[0]).days * 1440 + previous.hour * 60 + previous.minute
                delta = day[i] * 1440 + start[i] - offset
                movement.append(z3.If(selected[i], z3.If(delta >= 0, delta, -delta), 0))
        optimizer.minimize(z3.Sum(movement))
    optimizer.maximize(z3.Sum([z3.If(selected[i], a.preferenceScore, 0) for i, a in enumerate(activities)]))
    optimizer.minimize(z3.Sum([z3.If(selected[i], day[i] * 1440 + start[i], 0) for i in range(len(activities))]))
    warnings = [ESTIMATE_NOTICE, *problem.assumptions]
    if optimizer.check() == z3.sat:
        model = optimizer.model()
    else:
        warnings.append('Preference optimization timed out; the returned schedule still satisfies every hard constraint.')

    for i, outside in hour_breaks:
        if model.eval(outside, model_completion=True).as_long() > 0:
            warnings.append(f'"{activities[i].title}" falls outside your usual hours '
                            f'({problem.activeHours.start}–{problem.activeHours.end}) because it is a must-do.')
    for dt, over in budget_breaks:
        cents = model.eval(over, model_completion=True).as_long()
        if cents > 0:
            warnings.append(f'{dt}: about USD {cents / 100:.2f} over the daily budget because of must-do visits.')
    for dt, extra, count in pace_breaks:
        if model.eval(extra, model_completion=True).as_long() > 0:
            warnings.append(f'{dt}: {model.eval(count, model_completion=True).as_long()} places, more than your '
                            f'pace allows ({problem.maxActivitiesPerDay}), because of must-do visits.')

    result = []
    for i, a in enumerate(activities):
        if not z3.is_true(model.eval(selected[i])):
            continue
        d, m = model.eval(day[i]).as_long(), model.eval(start[i]).as_long()
        begin = datetime.combine(dates[d], time()) + timedelta(minutes=m)
        end = begin + timedelta(minutes=a.durationMinutes)
        is_locked = bool(a.fixedStart or a.anchorIndices or (old.get(a.id) and old[a.id].locked))
        result.append(Stop(id=a.id, day=d + 1, title=a.title, start=begin.isoformat(), end=end.isoformat(),
                           place=a.place, category=a.category, locked=is_locked,
                           priceRange=f'~USD {a.costCents / 100:.2f}/person (estimate)',
                           notes=' '.join(filter(None, [a.notes, 'Hours, cost and travel time are estimates.']))))
    result.sort(key=lambda s: (s.start, s.id))
    if not result:
        raise PlanningError(['No activities could be scheduled. Add feasible activity candidates.'])
    return result, list(dict.fromkeys(warnings))
