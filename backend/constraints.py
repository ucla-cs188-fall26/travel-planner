"""Bounded, data-only contract between the LLM and Z3. Times are destination-local."""
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .schemas import Place, Question

CLOCK = r'^(?:[01]\d|2[0-3]):[0-5]\d$'


class ConstraintModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


class Hours(ConstraintModel):
    start: str = Field(default='09:00', pattern=CLOCK)
    end: str = Field(default='18:00', pattern=CLOCK)

    @model_validator(mode='after')
    def ordered(self):
        if self.end <= self.start:
            raise ValueError('Active hours must end after they start on the same day.')
        return self


class VisitWindow(ConstraintModel):
    date: date
    start: str = Field(pattern=CLOCK)
    end: str = Field(pattern=CLOCK)

    @model_validator(mode='after')
    def ordered(self):
        if self.end <= self.start:
            raise ValueError('Visit windows must end after they start.')
        return self


class Activity(ConstraintModel):
    id: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=200)
    place: Place
    category: Literal['food', 'sight', 'activity', 'transit', 'lodging', 'free'] = 'sight'
    durationMinutes: int = Field(ge=15, le=720)
    windows: list[VisitWindow] = Field(min_length=1, max_length=28)
    required: bool = False
    anchorIndices: list[int] = Field(default_factory=list, max_length=40)
    fixedStart: datetime | None = None
    costCents: int = Field(default=0, ge=0, le=100_000_000)
    preferenceScore: int = Field(default=1, ge=1, le=100)
    notes: str = Field(default='', max_length=2000)

    @model_validator(mode='after')
    def local_fixed_start(self):
        if self.fixedStart and (self.fixedStart.tzinfo is not None or
                                self.fixedStart.second or self.fixedStart.microsecond):
            raise ValueError('fixedStart must be destination-local, on a whole minute, without an offset.')
        return self


class Before(ConstraintModel):
    beforeId: str
    afterId: str
    gapMinutes: int = Field(default=0, ge=0, le=1440)


class PlanningConstraints(ConstraintModel):
    version: Literal[1] = 1
    currency: Literal['USD'] = 'USD'
    activeHours: Hours = Field(default_factory=Hours)
    dailyBudgetCents: int | None = Field(default=None, ge=0, le=100_000_000)
    travelMinutes: int = Field(default=30, ge=0, le=180)
    minActivitiesPerDay: int = Field(default=1, ge=0, le=12)
    maxActivitiesPerDay: int = Field(default=5, ge=1, le=12)
    activities: list[Activity] = Field(min_length=1, max_length=40)
    before: list[Before] = Field(default_factory=list, max_length=80)
    assumptions: list[str] = Field(default_factory=list, max_length=20)

    @model_validator(mode='after')
    def references(self):
        ids = [a.id for a in self.activities]
        if len(set(ids)) != len(ids):
            raise ValueError('Activity IDs must be unique.')
        if self.minActivitiesPerDay > self.maxActivitiesPerDay:
            raise ValueError('Daily minimum exceeds daily maximum.')
        for edge in self.before:
            if edge.beforeId not in ids or edge.afterId not in ids or edge.beforeId == edge.afterId:
                raise ValueError('Ordering references must name two different existing activities.')
        return self


class Extraction(ConstraintModel):
    status: Literal['gathering', 'ready']
    reply: str = Field(min_length=1, max_length=4000)
    question: Question | None = None
    destination: str | None = None
    constraints: PlanningConstraints | None = None

    @model_validator(mode='after')
    def ready_has_constraints(self):
        if self.status == 'ready' and self.constraints is None:
            raise ValueError('A ready response needs constraints.')
        if self.status == 'gathering' and self.question is None:
            raise ValueError('Ask a question when more information is needed.')
        return self


class InitialExtraction(Extraction):
    @model_validator(mode='after')
    def include_additional_places(self):
        if self.status == 'ready' and not any(
            not a.required and not a.anchorIndices and a.fixedStart is None for a in self.constraints.activities
        ):
            raise ValueError('Include optional real places beyond the must-do anchors for the user to choose from.')
        return self


class SuggestionProposal(ConstraintModel):
    id: str = Field(min_length=1, max_length=64)
    context: str
    constraints: PlanningConstraints
    suggestionIds: list[str] = Field(min_length=1, max_length=40)
