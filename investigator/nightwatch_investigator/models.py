"""Versioned public values; no Guard Room or model SDK dependencies."""
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Value(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Confirmation(Value):
    seq: int
    at: str
    status: Literal["ok", "warning", "failing"]
    errors: float | int | None
    p95_ms: float | int | None


class Detection(Value):
    schema_version: Literal["nightwatch.detection.v1"] = "nightwatch.detection.v1"
    id: str
    source_id: str
    node_id: str
    rule: Literal["persistent_node_status.v1"] = "persistent_node_status.v1"
    status: Literal["active", "recovered"]
    detected_at: str
    recovered_at: str | None = None
    summary: str
    event_seq: int = Field(ge=1)
    created_cursor: int = Field(ge=1)
    investigation_id: None = None


class DetectionDetail(Detection):
    confirmations: list[Confirmation]
    snapshot: dict[str, Any]
    recovery_confirmations: list[Confirmation] = Field(default_factory=list)
    recovery_snapshot: dict[str, Any] | None = None


class Event(Value):
    schema_version: Literal["nightwatch.investigator-event.v1"] = "nightwatch.investigator-event.v1"
    event_id: str
    cursor: int = Field(ge=1)
    detection_id: str
    investigation_id: None = None
    seq: int = Field(ge=1)
    occurred_at: str
    type: Literal["detection.created", "detection.recovered"]
    payload: Detection


class ObservationStatus(Value):
    status: Literal["waiting", "ok", "unavailable", "stale", "out_of_order"] = "waiting"
    checked_at: str | None = None
    last_success_at: str | None = None
    snapshot_at: str | None = None
    snapshot_seq: int | None = None
    message: str = "等待第一次觀測"


class State(Value):
    schema_version: Literal["nightwatch.investigator-state.v1"] = "nightwatch.investigator-state.v1"
    stream_id: str
    cursor: int = Field(ge=0)
    server_now: str
    runner_available: Literal[False] = False
    source: ObservationStatus
    active_count: int = Field(ge=0)
    recent_detections: list[Detection]


class EventPage(Value):
    stream_id: str
    items: list[Event]
    next_after: int = Field(ge=0)
    has_more: bool


class DetectionPage(Value):
    items: list[Detection]
    next_before: int | None
