"""Wire models mirror frontend/src/app/core/constraint-models.ts.

The service accepts a snapshot, computes a proposal, and never persists a trip.
Domain validation is deliberately separate so unsupported input gets a useful
insufficient_data/incomplete result rather than an unrelated solver failure.
"""
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictFloat, StrictInt, StrictStr


class WireModel(BaseModel):
    model_config = ConfigDict(extra="ignore", allow_inf_nan=False)


class Place(WireModel):
    name: str
    placeId: str | None = None
    lat: float | None = None
    lng: float | None = None
    address: str | None = None


class Stop(WireModel):
    id: str
    day: int = Field(ge=1)
    title: str
    start: str
    end: str
    place: Place
    category: Literal["food", "sight", "activity", "transit", "lodging", "free"] = "sight"
    locked: bool = False
    priceRange: str | None = None
    sourceUrl: str | None = None
    notes: str | None = None


class Trip(WireModel):
    id: str
    name: str
    ownerId: str
    memberIds: list[str] = Field(default_factory=list, max_length=64)
    startDate: str
    endDate: str
    status: str = "gathering"
    details: dict[str, Any] = Field(default_factory=dict)
    anchors: list[str] = Field(default_factory=list, max_length=24)
    overrides: dict[str, Any] = Field(default_factory=dict)
    stops: list[Stop] = Field(default_factory=list, max_length=100)


class ConstraintRecord(WireModel):
    id: str
    ownerId: str
    kind: Literal["budget_max", "day_start_min", "day_end_max", "walking_max", "max_activities", "interest", "include_place", "exclude_place"]
    value: StrictInt | StrictFloat | StrictStr
    hard: StrictBool
    sourceQuestionId: str | None = None


class Answer(WireModel):
    questionId: str
    questionVersion: Literal[1]
    choice: Literal["A", "B", "indifferent"]
    createdAt: float


class MemberSession(WireModel):
    uid: str
    schemaVersion: Literal[1]
    revision: int = Field(ge=0)
    confirmed: bool
    answers: list[Answer] = Field(max_length=100)
    answerHistory: list[Answer] = Field(default_factory=list, max_length=500)
    constraints: list[ConstraintRecord] = Field(max_length=40)
    updatedAt: float


class Times(WireModel):
    start: str
    end: str


class EditDiff(WireModel):
    stopId: str
    from_: Times = Field(alias="from")
    to: Times


class SolveRequest(WireModel):
    trip: Trip
    members: list[MemberSession] = Field(max_length=64)
    catalogId: str
    inputVersion: str = Field(min_length=1, max_length=256)
    requestedEdits: list[EditDiff] = Field(default_factory=list, max_length=20)
