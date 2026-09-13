"""Guard Room presentation boundary: local graph + remote detection data."""
import asyncio
import copy
import json
import os
from contextlib import asynccontextmanager

from fastapi import Query, Request
from fastapi.responses import JSONResponse, StreamingResponse

from investigator_client import InvestigatorClient, InvestigatorResponseError, InvestigatorUnavailable
from time_utils import timestamp


def install_investigator(app, *, client_factory=None):
    previous = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(application):
        async with previous(application):
            client = (client_factory or (lambda: InvestigatorClient(os.getenv("INVESTIGATOR_URL", "http://127.0.0.1:9998"))))()
            application.state.investigator_client = client
            try:
                yield
            finally:
                await client.close()
    app.router.lifespan_context = lifespan

    def client():
        return app.state.investigator_client

    async def presentation():
        try:
            remote = await client().state()
            available, message = True, None
        except (InvestigatorUnavailable, InvestigatorResponseError):
            remote = copy.deepcopy(client().last_state)
            available, message = False, "Investigator 連線中斷；顯示最後收到的狀態，尚未確認新的異常或恢復。"
        return {"schema_version": "nightwatch.observation-workspace.v1", "server_now": timestamp(),
                "graph": copy.deepcopy(app.state.graph_store.snapshot),
                "investigator": {"available": available, "message": message, "state": remote}}

    headers = {"Cache-Control": "no-store"}

    @app.exception_handler(InvestigatorUnavailable)
    async def unavailable(request, error):
        return JSONResponse({"error": {"code": "investigator_unavailable", "message_zh": str(error)}}, status_code=503, headers=headers)

    @app.exception_handler(InvestigatorResponseError)
    async def upstream_error(request, error):
        return JSONResponse({"error": {"code": "investigator_request_error", "message_zh": {
            404: "找不到這筆偵測紀錄", 409: "事件紀錄已變更，請重新取得狀態", 422: "查詢參數不合法"
        }[error.status]}}, status_code=error.status, headers=headers)

    @app.get("/api/investigator/state", tags=["Investigator"])
    async def state():
        return JSONResponse(await presentation(), headers=headers)

    @app.get("/api/detections", tags=["Investigator"])
    async def detections(limit: int = Query(default=100, ge=1, le=500), before: int | None = Query(default=None, ge=1)):
        params = {"limit": limit}
        if before is not None:
            params["before"] = before
        return JSONResponse(await client().read("v1/detections", "DetectionPage", params), headers=headers)

    @app.get("/api/detections/{identifier}", tags=["Investigator"])
    async def detection(identifier: str):
        from urllib.parse import quote
        return JSONResponse(await client().read("v1/detections/" + quote(identifier, safe=""), "DetectionDetail"), headers=headers)

    @app.get("/api/investigator/events", tags=["Investigator"])
    async def events(stream_id: str, after: int = Query(default=0, ge=0), limit: int = Query(default=100, ge=1, le=500)):
        return JSONResponse(await client().events(after, stream_id, limit), headers=headers)

    @app.post("/api/investigations", tags=["Investigations"])
    async def start():
        # No runner exists. Do not create a job that would remain running forever.
        return JSONResponse({"error": {"code": "runner_unavailable", "message_zh": "AI 調查尚未接入，未建立調查。"}}, status_code=503, headers=headers)

    @app.get("/api/investigator/stream", tags=["Investigator"])
    async def stream(request: Request, after: int | None = Query(default=None, ge=0), stream_id: str | None = None):
        # Explicit query takes precedence; native EventSource reconnect uses Last-Event-ID.
        if after is None and request.headers.get("last-event-id"):
            try:
                stream_id, raw = request.headers["last-event-id"].rsplit(":", 1)
                after = int(raw)
                if after < 0:
                    raise ValueError()
            except ValueError:
                return JSONResponse({"error": {"code": "invalid_cursor", "message_zh": "事件續傳位置不合法"}}, status_code=400)
        if after is not None and not stream_id:
            return JSONResponse({"error": {"code": "invalid_cursor", "message_zh": "續傳需要 stream_id"}}, status_code=400)

        def frame(kind, value, identifier=None):
            prefix = f"id: {identifier}\n" if identifier is not None else ""
            return prefix + f"event: {kind}\ndata: {json.dumps(value, ensure_ascii=False)}\n\n"

        async def generate():
            cursor, journal = after, stream_id
            while not await request.is_disconnected():
                value = await presentation()
                remote = value["investigator"]
                state = remote["state"]
                reset = False
                if remote["available"]:
                    if journal != state["stream_id"] or cursor is None or cursor > state["cursor"]:
                        cursor, journal = state["cursor"], state["stream_id"]
                        reset = True
                yield frame("state", value)
                if reset:
                    # State and cursor came from one synchronous database snapshot.
                    yield frame("reset", {"stream_id": journal, "cursor": cursor}, f"{journal}:{cursor}")
                if remote["available"]:
                    try:
                        # Bound work per iteration so graph and connectivity stay live during replay.
                        page = await client().events(cursor, journal, 100)
                        for event in page["items"]:
                            yield frame("detection", event, f"{journal}:{event['cursor']}")
                            cursor = event["cursor"]
                    except InvestigatorResponseError:
                        journal = None  # Reload snapshot after a journal replacement.
                    except InvestigatorUnavailable:
                        yield frame("source_error", {"message": "偵測事件暫時無法同步；保留續傳位置"})
                yield frame("ping", {"server_now": timestamp()})
                await asyncio.sleep(2)
        return StreamingResponse(generate(), media_type="text/event-stream", headers={**headers, "X-Accel-Buffering": "no"})
