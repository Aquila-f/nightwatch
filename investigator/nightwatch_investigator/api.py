"""Private service API. Browsers access it through Guard Room."""
import asyncio
from contextlib import asynccontextmanager, suppress
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse
import httpx

from .models import DetectionDetail, DetectionPage, EventPage, State
from .observation import GraphSource
from .service import Investigator
from .store import Store


def create_app(*, db_path=None, graph_url=None, source_id=None, poll_seconds=None, transport=None):
    @asynccontextmanager
    async def lifespan(app):
        path = db_path or os.getenv("INVESTIGATOR_DB", str(Path(__file__).resolve().parents[1] / ".data/investigator.sqlite3"))
        store = Store(path, source_id or os.getenv("INVESTIGATOR_SOURCE_ID", "guardroom"))
        try:
            interval = float(poll_seconds if poll_seconds is not None else os.getenv("INVESTIGATOR_POLL_SECONDS", "5"))
            if not 0 < interval <= 5:
                raise ValueError("INVESTIGATOR_POLL_SECONDS must be in (0, 5]")
            async with httpx.AsyncClient(timeout=3, follow_redirects=False, transport=transport) as client:
                source = GraphSource(graph_url or os.getenv("NIGHTWATCH_GRAPH_URL", "http://127.0.0.1:9999/api/graph"), client)
                service = Investigator(store, source, interval)
                app.state.store, app.state.service = store, service
                task = asyncio.create_task(service.run())
                try:
                    yield
                finally:
                    task.cancel()
                    with suppress(asyncio.CancelledError):
                        await task
        finally:
            store.close()

    app = FastAPI(title="NightWatch Investigator", version="0.2.0", lifespan=lifespan)

    @app.middleware("http")
    async def no_cache(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/health/ready")
    async def health():
        # Readiness does not depend on Guard Room, avoiding a startup dependency cycle.
        app.state.store.cursor()
        return {"status": "ok", "runner_available": False}

    @app.get("/v1/state", response_model=State)
    async def state():
        return app.state.store.state()

    @app.get("/v1/events", response_model=EventPage)
    async def events(after: int = Query(default=0, ge=0, le=9223372036854775807),
                     limit: int = Query(default=100, ge=1, le=500), stream_id: str | None = None):
        if stream_id is not None and stream_id != app.state.store.stream_id:
            raise HTTPException(409, "Event journal changed; reload state")
        try:
            return app.state.store.events(after, limit)
        except ValueError as error:
            raise HTTPException(409, str(error)) from None

    @app.get("/v1/detections", response_model=DetectionPage)
    async def detections(limit: int = Query(default=100, ge=1, le=500),
                         before: int | None = Query(default=None, ge=1, le=9223372036854775807)):
        return app.state.store.list(limit, before)

    @app.get("/v1/detections/{identifier}", response_model=DetectionDetail)
    async def detection(identifier: str):
        value = app.state.store.detail(identifier)
        if value is None:
            raise HTTPException(404, "Unknown detection")
        return value

    @app.get("/v1/investigations")
    async def investigations():
        return {"items": [], "next_before": None, "runner_available": False}

    @app.post("/v1/investigations")
    async def create_investigation():
        return JSONResponse({"error": {"code": "runner_unavailable", "message_zh": "AI 調查尚未接入，未建立調查。"}}, status_code=503)

    return app


app = create_app()
