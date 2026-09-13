# Investigator ↔ Guard Room contract v1

Machine-readable contract: [investigator.schema.json](schemas/investigator.schema.json).
The schema contains State, Detection, DetectionDetail, Event and pagination definitions. Runtime models live in Investigator; Guard Room validates the published JSON schema without importing that package. Tests compare the published schema with runtime models.

## Ownership

Investigator owns detection records and its journal. Guard Room obtains them through HTTP, combines them with its own graph, and exposes browser-facing routes. There is no shared database, model SDK payload, or direct browser connection to Investigator.

Detection is an observed symptom, not an investigation or a root-cause conclusion. The first release has no runner; investigation_id is null, runner_available is false, and no thinking/report events are emitted.

## Resources

- `GET /v1/state`: snapshot with stream_id, cursor, source status, active_count and the newest 20 detection summaries.
- `GET /v1/detections?limit=100&before=<created_cursor>`: descending creation order, next_before=null at end. Limit 1–500.
- `GET /v1/detections/{id}`: includes the exact triggering graph and confirming measurements; recovery adds its own graph and measurements. Unknown ID returns 404.
- `GET /v1/events?after=0&stream_id=<id>&limit=100`: ascending journal cursor, next_after remains at input when empty, has_more indicates another page. Wrong stream_id or cursor beyond current journal returns 409.
- `POST /v1/investigations`: 503 runner_unavailable without creating a resource. `GET /v1/investigations` returns an empty list.

Graph input follows [snapshot.schema.json](schemas/snapshot.schema.json). Runtime data is finite JSON, fetched from the configured live source. Detection source_id is stable and owns a database; a different source_id cannot open that database.

## Events

An event carries schema_version=`nightwatch.investigator-event.v1`, event_id, cursor, detection_id, investigation_id, seq, occurred_at, type and payload.

- `detection.created`: payload is the new active Detection summary.
- `detection.recovered`: payload is the recovered Detection summary.

event_id is immutable and unique. cursor is globally increasing within stream_id. seq increases within a detection. Event and detection state commit atomically. occurred_at is the event creation time; detected_at / recovered_at are the observed graph times. Delivery can repeat; consumers deduplicate. Timestamp ordering is not a substitute for cursor ordering.

No pruning is implemented in v1. stream_id survives process restart; a new database gets a new stream_id. Fresh confirmation counters restart with the process, but active records, events and accepted graph checkpoint survive.

## Browser presentation

Guard Room exposes `/api/investigator/state`, `/api/investigator/stream`, `/api/investigator/events`, `/api/detections` and `/api/detections/{id}`. The state envelope is `nightwatch.observation-workspace.v1`: server_now, local graph, and investigator {available, message, state}. A cached remote state is explicitly marked unavailable during outages; it is not evidence of current recovery.

SSE frames:
- state: the complete presentation snapshot.
- reset: stream_id + cursor; establish a baseline from the preceding state.
- detection: a persisted Investigator event.
- source_error: event retrieval is temporarily unavailable.
- ping: transport heartbeat only.

SSE IDs are `stream_id:cursor`. Reconnect via after + stream_id query parameters or Last-Event-ID. A reconnect state never advances the client's replay cursor. A reset explicitly replaces the old baseline. Browser summaries retain the highest per-detection seq so replay cannot undo a newer snapshot.

Manual `POST /api/investigations` returns 503 runner_unavailable. Old model-oriented investigation routes are removed; existing database files remain untouched. Model progress, Evidence and Report contracts will be versioned when the runner is implemented.
