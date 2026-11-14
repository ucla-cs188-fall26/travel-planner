from typing import Any, Literal
from pydantic import BaseModel, Field

LOCAL_DATETIME = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$"

class ActiveHours(BaseModel):
    start: str
    end: str


class Preferences(BaseModel):
    budgetPerDay: float | None = None
    activeHours: ActiveHours | None = None
    interests: list[str] = Field(default_factory=list)
    dietary: list[str] = Field(default_factory=list)
    activityLevel: Literal["low", "medium", "high"] | None = None
    pace: Literal["relaxed", "balanced", "packed"] | None = None


class GroupMember(BaseModel):
    uid: str
    name: str
    preferences: Preferences = Field(default_factory=Preferences)


class Conflict(BaseModel):
    field: str
    message: str


class GroupPreferences(BaseModel):
    members: list[GroupMember] = Field(default_factory=list)
    merged: Preferences = Field(default_factory=Preferences)
    conflicts: list[Conflict] = Field(default_factory=list)


# ---------- Itinerary ----------

class Place(BaseModel):
    name: str
    placeId: str | None = None
    lat: float | None = None
    lng: float | None = None
    address: str | None = None


class Stop(BaseModel):
    id: str
    day: int = Field(ge=1)
    title: str
    start: str = Field(pattern=LOCAL_DATETIME)
    end: str = Field(pattern=LOCAL_DATETIME)
    place: Place
    category: Literal["food", "sight", "activity", "transit", "lodging", "free"] = "sight"
    locked: bool = False  # True = anchor, never move it
    priceRange: str | None = None
    sourceUrl: str | None = None
    notes: str | None = None


class Trip(BaseModel):
    id: str
    name: str
    ownerId: str
    memberIds: list[str] = Field(default_factory=list)
    startDate: str
    endDate: str
    status: Literal["gathering", "ready", "planned"] = "gathering"
    details: dict[str, Any] = Field(default_factory=dict)
    anchors: list[str] = Field(default_factory=list)
    overrides: dict[str, Any] = Field(default_factory=dict)
    stops: list[Stop] = Field(default_factory=list)


# ---------- Chat ----------

class ChatMessage(BaseModel):
    id: str
    role: Literal["user", "assistant"]
    text: str
    createdAt: float


class Question(BaseModel):
    id: str
    field: str  # key in trip.details where the answer is saved
    type: Literal["single_choice", "multi_choice", "text", "date_range", "number_range"]
    prompt: str
    options: list[str] | None = None


class ComparisonOption(BaseModel):
    id: str
    title: str
    cost: str
    travelTime: str
    location: str
    suits: list[str]
    sourceUrl: str | None = None


class Comparison(BaseModel):
    id: str
    prompt: str
    options: tuple[ComparisonOption, ComparisonOption]


class ChatRequest(BaseModel):
    """What the frontend sends to POST /api/chat."""
    message: str
    trip: Trip
    groupPreferences: GroupPreferences | None = None
    recentMessages: list[ChatMessage] = Field(default_factory=list)


class ChatResponse(BaseModel):
    """What POST /api/chat sends back."""
    status: Literal["gathering", "ready"]
    reply: str
    question: Question | None = None
    extracted: dict[str, Any] = Field(default_factory=dict)
    comparison: Comparison | None = None
    itinerary: list[Stop] | None = None


# ---------- Calendar edits ----------

class TimeRange(BaseModel):
    start: str = Field(pattern=LOCAL_DATETIME)
    end: str = Field(pattern=LOCAL_DATETIME)


class EditDiff(BaseModel):
    stopId: str
    to: TimeRange
    from_: TimeRange = Field(alias="from")

    model_config = {"populate_by_name": True}


class ChangeRequest(BaseModel):
    diff: list[EditDiff]
    trip: Trip  # stops already include the user's drag
    groupPreferences: GroupPreferences | None = None


class ChangeResponse(BaseModel):
    summary: str
    changes: list[Stop]  # only stops that were added or changed
    warnings: list[str] = Field(default_factory=list)