"""Frontend routes installed on the existing Guard Room FastAPI application."""

import asyncio
import json
from pathlib import Path
import re
import time

from fastapi import Request
from fastapi.openapi.utils import get_openapi
from fastapi.responses import JSONResponse, StreamingResponse
from frontend_live import LiveStore
from time_utils import timestamp


SCHEMAS = Path(__file__).resolve().parents[2] / "contracts" / "schemas"


class APIError(Exception):
    def __init__(self, status, code, message):
        self.status = status
        self.body = {"error": {"code": code, "message_zh": message, "details": {}}}
        super().__init__(message)


READ_ROUTES = {
    "/health": ("health", None, "HTTP 服務存活"),
    "/api/readiness": ("readiness", "readiness", "就緒狀態"),
    "/api/state": ("state", "state", "完整初始狀態"),
    "/api/capabilities": ("capabilities", None, "節點與能力表"),
    "/api/debug/logs": ("logs", None, "近期日誌"),
    "/api/incidents": ("incidents", None, "事故清單"),
    "/api/incidents/{id}": ("incident", None, "事故詳情"),
    "/api/incidents/{id}/snapshots": ("snapshots", None, "事故快照"),
    "/api/incidents/{id}/events": ("incident_events", None, "事故事件紀錄"),
}


def install_frontend(app, log_hub=None):
    store = LiveStore(app, APIError)
    headers = {"Cache-Control": "no-store"}

    def response(data, status=200):
        return JSONResponse(data, status_code=status, headers=headers)

    @app.exception_handler(APIError)
    async def api_error(request, error):
        return response(error.body, error.status)

    def check_query(request, allowed=()):
        query = request.query_params
        if set(query) - set(allowed) or any(len(query.getlist(key)) != 1 for key in query):
            raise APIError(400, "invalid_request", "不支援或重複的查詢參數")
        return dict(query)

    def read_endpoint(name):
        async def endpoint(request: Request):
            query = check_query(request, ("service", "limit") if name == "logs" else ())
            if "limit" in query and (not re.fullmatch(r"[0-9]+", query["limit"]) or not 1 <= int(query["limit"]) <= 20000):
                raise APIError(400, "invalid_request", "limit 必須是 1–20000 的整數")
            if name == "health":
                data = {"status": "ok"}
            elif name in ("state", "readiness", "capabilities"):
                state = store.stream_snapshot()[0]
                data = state if name == "state" else state[name]
            else:
                data = store.read(name, request.path_params, query)
            return response(data)
        return endpoint

    error_schema = {"type": "object", "required": ["error"], "properties": {
        "error": {"type": "object", "required": ["code", "message_zh", "details"], "properties": {
            "code": {"type": "string"}, "message_zh": {"type": "string"}, "details": {"type": "object"}}}}}
    errors = {code: {"description": message, "content": {"application/json": {"schema": error_schema}}}
              for code, message in [(400, "參數錯誤"), (404, "找不到資源"), (503, "服務無法使用")]}

    def path_parameters(path):
        return [{"name": "id", "in": "path", "required": True, "schema": {"type": "string"}}] if "{id}" in path else []

    for path, (name, schema, title) in READ_ROUTES.items():
        shape = {"$ref": f"#/components/schemas/{schema}"} if schema else {"type": "object"}
        if name in ("logs", "incidents", "incident_events"):
            shape = {"type": "array", "items": {"$ref": "#/components/schemas/incident-commit"} if name == "incident_events" else {"type": "object"}}
        parameters = path_parameters(path)
        if name == "logs":
            parameters += [{"name": "service", "in": "query", "schema": {"type": "string"}},
                           {"name": "limit", "in": "query", "schema": {"type": "integer", "minimum": 1, "maximum": 20000, "default": 20}}]
        app.add_api_route(path, read_endpoint(name), methods=["GET"], name=f"frontend_{name}", summary=title,
                          tags=["Frontend"], responses={200: {"content": {"application/json": {"schema": shape}}}, **errors},
                          openapi_extra={"parameters": parameters})
    @app.get("/events", tags=["Frontend"], summary="前端 SSE", response_class=StreamingResponse,
             responses={200: {"content": {"text/event-stream": {"schema": {"type": "string"}}}}, **errors},
             openapi_extra={"parameters": [{"name": "cursor", "in": "query", "schema": {"type": "string", "pattern": "^[^:]+:[0-9]+$"}}]})
    async def events(request: Request):
        query = check_query(request, ("cursor",))
        cursor = query.get("cursor", request.headers.get("last-event-id"))
        if cursor is not None and not re.fullmatch(r"[^:]+:[0-9]+", cursor):
            raise APIError(400, "invalid_request", "cursor 必須是 <run_id>:<revision>")
        state = store.state()
        def live_frame(name, data):
            event_id = f"id: {data['run_id']}:{data['revision']}\n" if name == "incident" else ""
            return f"{event_id}event: {name}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

        async def live_stream():
            queue = log_hub.subscribe() if log_hub is not None else None
            try:
                yield live_frame("state", state)
                yield live_frame("graph", state["graph_now"])
                graph_seq = state["graph_now"]["seq"]
                ping_at = time.monotonic() + 2
                while not await request.is_disconnected():
                    if queue is not None:
                        while not queue.empty():
                            payload = queue.get_nowait()
                            if payload is None:
                                return
                            yield live_frame("log", payload)
                    graph = store.graph_store.snapshot
                    if graph["seq"] != graph_seq:
                        yield live_frame("graph", graph)
                        graph_seq = graph["seq"]
                    if time.monotonic() >= ping_at:
                        yield live_frame("ping", {"server_now": timestamp()})
                        ping_at = time.monotonic() + 2
                    await asyncio.sleep(0.2)
            finally:
                if queue is not None:
                    log_hub.subscribers.discard(queue)
        return StreamingResponse(live_stream(), media_type="text/event-stream", headers={**headers, "X-Accel-Buffering": "no"})

    def convert(value):
        if isinstance(value, dict):
            result = {}
            for key, item in value.items():
                if key == "$schema":
                    continue
                if key == "$ref":
                    filename, _, fragment = item.partition("#")
                    item = "#/components/schemas/" + filename.removesuffix(".schema.json") + fragment
                else:
                    item = convert(item)
                result[key] = item
            return result
        if isinstance(value, list):
            return [convert(item) for item in value]
        return value

    def openapi():
        if app.openapi_schema is None:
            document = get_openapi(title=app.title, version=app.version, routes=app.routes,
                                  description="Monitor graph 與 Investigator HTTP 契約提供前端資料。")
            definitions = document.setdefault("components", {}).setdefault("schemas", {})
            for name in ("state", "readiness", "snapshot", "node", "edge", "faults", "incident-commit"):
                definitions[name] = convert(json.loads((SCHEMAS / f"{name}.schema.json").read_text()))
            app.openapi_schema = document
        return app.openapi_schema
    app.openapi = openapi
