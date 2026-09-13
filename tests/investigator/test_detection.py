import asyncio
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest

import httpx
from fastapi import FastAPI
from pydantic.json_schema import models_json_schema

from nightwatch_investigator.api import create_app
from nightwatch_investigator.models import State, EventPage, DetectionPage, DetectionDetail
from nightwatch_investigator.observation import GraphSource
from nightwatch_investigator.preprocessor import Preprocessor, instant
from nightwatch_investigator.service import Investigator
from nightwatch_investigator.store import Store
from investigator_api import install_investigator
from investigator_client import InvestigatorClient, InvestigatorUnavailable


def graph(seq, statuses=None, at=None):
    statuses = statuses or {"a": "warning"}
    return {"schema_version": "nightwatch.snapshot.v2", "seq": seq,
            "at": (at or datetime.now(timezone.utc)).isoformat().replace("+00:00", "Z"),
            "nodes": [{"id": key, "kind": "service", "status": status, "traffic": 2.0,
                       "errors": 0.5 if status == "warning" else 0.0, "p95_ms": 100.0,
                       "saturation": None, "alive": True, "sat_label": "utilization",
                       "assessment": "unassessed", "trend": {"errors": "na", "latency": "na", "saturation": "na"},
                       "extras": {}, "checks": [], "logs_indexed": False} for key, status in statuses.items()],
            "edges": [], "sources": {name: {"ok": name == "logstore", "age_secs": 0.0}
                                      for name in ("logstore", "prometheus", "jaeger")}, "gap_before": None}


class DetectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "investigator.sqlite3"
        self.store = Store(self.path, "test")
        self.preprocessor = Preprocessor()
        self.base = datetime.now(timezone.utc)
        self.seq = 0
        self.addCleanup(lambda: self.store.close())

    def feed(self, statuses=None):
        self.seq += 1
        value = graph(self.seq, statuses, self.base + timedelta(seconds=self.seq * 5))
        status, changes = self.preprocessor.observe(value, self.store.get("checkpoint"), self.store.active(), instant(value["at"]))
        self.assertEqual(status, "ok")
        self.store.commit(value, changes, {})
        return value

    def test_confirmation_exact_snapshot_and_per_node_recovery(self):
        self.feed(); self.feed()
        self.assertEqual(self.store.cursor(), 0)
        trigger = self.feed()
        first = self.store.active()["a"]
        self.assertEqual(first["snapshot"], trigger)
        self.assertEqual(len(first["confirmations"]), 3)
        for _ in range(3):
            self.feed({"a": "warning", "b": "failing"})
        self.assertEqual(set(self.store.active()), {"a", "b"})
        for _ in range(3):
            recovery = self.feed({"a": "ok", "b": "failing"})
        self.assertEqual(set(self.store.active()), {"b"})
        saved = self.store.detail(first["id"])
        self.assertEqual(saved["recovery_snapshot"], recovery)
        self.assertEqual(saved["status"], "recovered")
        self.assertEqual(self.store.cursor(), 3)
        for _ in range(3):
            self.feed({"a": "warning", "b": "failing"})
        self.assertNotEqual(self.store.active()["a"]["id"], first["id"])

    def test_duplicates_stale_and_missing_never_confirm_or_recover(self):
        value = self.feed()
        status, changes = self.preprocessor.observe(value, self.store.get("checkpoint"), {}, instant(value["at"]))
        self.assertEqual((status, changes), ("duplicate", []))
        stale_at = instant(value["at"]) + timedelta(seconds=30)
        self.assertEqual(self.preprocessor.observe(value, self.store.get("checkpoint"), {}, stale_at), ("stale", []))
        self.feed(); self.feed()
        self.assertEqual(self.store.cursor(), 0)
        self.feed()
        for _ in range(4):
            self.feed({"a": "unknown"})
        for _ in range(4):
            self.feed({"b": "ok"})
        self.assertIn("a", self.store.active())
        self.assertEqual(self.store.cursor(), 1)

    def test_gaps_and_out_of_order_break_confirmation(self):
        value = self.feed()
        self.assertEqual(self.preprocessor.observe(graph(0, at=self.base), self.store.get("checkpoint"), {}, self.base), ("out_of_order", []))
        self.feed(); self.feed()
        self.assertEqual(self.store.cursor(), 0)
        self.base += timedelta(seconds=30)
        self.feed(); self.feed()
        self.assertEqual(self.store.cursor(), 0)
        self.feed()
        self.assertEqual(self.store.cursor(), 1)

    def test_restart_keeps_active_detections_and_cursor(self):
        self.feed(); self.feed(); self.feed()
        saved, journal = self.store.active()["a"], self.store.stream_id
        self.store.close()
        self.store = Store(self.path, "test")
        self.preprocessor = Preprocessor()
        for _ in range(4):
            self.feed()
        self.assertEqual(self.store.stream_id, journal)
        self.assertEqual(self.store.cursor(), 1)
        self.assertEqual(self.store.active()["a"]["id"], saved["id"])

    def test_atomic_rollback_and_replay_pagination(self):
        self.feed(); self.feed(); self.feed()
        checkpoint = self.store.get("checkpoint")
        with self.assertRaises(KeyError):
            self.store.commit(graph(4), [{"node_id": "missing", "action": "recovered", "confirmations": []}], {})
        self.assertEqual(self.store.cursor(), 1)
        self.assertEqual(self.store.get("checkpoint"), checkpoint)
        for _ in range(3):
            self.feed({"a": "ok"})
        first = self.store.events(0, 1)
        second = self.store.events(first["next_after"], 1)
        self.assertTrue(first["has_more"])
        self.assertFalse(second["has_more"])
        self.assertEqual([first["items"][0]["type"], second["items"][0]["type"]], ["detection.created", "detection.recovered"])
        self.assertEqual(self.store.events(2)["items"], [])
        with self.assertRaises(ValueError):
            self.store.events(3)

    def test_single_writer_and_source_ownership(self):
        with self.assertRaises(BlockingIOError):
            Store(self.path, "test")
        self.store.close()
        with self.assertRaises(ValueError):
            Store(self.path, "other")
        self.store = Store(self.path, "test")

    def test_published_schema_matches_runtime_models(self):
        _, schema = models_json_schema([(model, "validation") for model in (State, EventPage, DetectionPage, DetectionDetail)])
        root = Path(__file__).resolve().parents[2]
        self.assertEqual(schema, json.loads((root / "contracts/schemas/investigator.schema.json").read_text()))


class BoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(Path(self.temp.name) / "test.db", "test")
        self.addCleanup(self.store.close)
        self.inv = create_app()
        self.inv.state.store = self.store
        self.bridge = InvestigatorClient("http://investigator", transport=httpx.ASGITransport(app=self.inv))
        self.addAsyncCleanup(self.bridge.close)
        self.guard = FastAPI()
        self.guard.state.graph_store = SimpleNamespace(snapshot=graph(1))
        self.guard.state.investigator_client = self.bridge
        install_investigator(self.guard)
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.guard), base_url="http://guardroom")
        self.addAsyncCleanup(self.http.aclose)

    def create_detection(self):
        value = graph(1)
        row = {key: value["nodes"][0][key] for key in ("status", "errors", "p95_ms")}
        row.update(seq=1, at=value["at"])
        self.store.commit(value, [{"action": "created", "node_id": "a", "confirmations": [row] * 3}], {})
        return self.store.active()["a"]

    async def test_guardroom_reads_contract_and_disables_manual_runner(self):
        created = self.create_detection()
        response = await self.http.get("/api/investigator/state")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["investigator"]["available"])
        self.assertEqual(response.json()["investigator"]["state"]["active_count"], 1)
        rows = await self.http.get("/api/detections")
        self.assertEqual(rows.json()["items"][0]["id"], created["id"])
        detail = await self.http.get("/api/detections/" + created["id"])
        self.assertEqual(detail.json()["snapshot"], created["snapshot"])
        self.assertEqual((await self.http.get("/api/detections/unknown")).status_code, 404)
        disabled = await self.http.post("/api/investigations", json={"request_id": "manual"})
        self.assertEqual(disabled.status_code, 503)
        self.assertEqual(disabled.json()["error"]["code"], "runner_unavailable")
        self.assertEqual(self.store.cursor(), 1)

    async def test_offline_source_keeps_local_graph_and_marks_cached_state(self):
        self.create_detection()
        await self.http.get("/api/investigator/state")
        await self.bridge.close()
        self.guard.state.graph_store.snapshot = graph(9)
        response = (await self.http.get("/api/investigator/state")).json()
        self.assertEqual(response["graph"]["seq"], 9)
        self.assertFalse(response["investigator"]["available"])
        self.assertEqual(response["investigator"]["state"]["active_count"], 1)
        self.assertEqual((await self.http.get("/api/detections")).status_code, 503)

    async def test_event_resume_and_wrong_journal(self):
        self.create_detection()
        params = {"after": 0, "stream_id": self.store.stream_id}
        page = (await self.http.get("/api/investigator/events", params=params)).json()
        self.assertEqual(page["items"][0]["cursor"], 1)
        params["after"] = page["next_after"]
        self.assertEqual((await self.http.get("/api/investigator/events", params=params)).json()["items"], [])
        params["stream_id"] = "old"
        self.assertEqual((await self.http.get("/api/investigator/events", params=params)).status_code, 409)

    async def test_sse_replays_saved_event_and_reset_has_snapshot_cursor(self):
        self.create_detection()
        endpoint = next(route.endpoint for route in self.guard.routes if route.path == "/api/investigator/stream")
        async def connected():
            return False
        request = SimpleNamespace(headers={}, is_disconnected=connected)
        response = await endpoint(request, after=0, stream_id=self.store.stream_id)
        iterator = response.body_iterator
        self.assertIn("event: state", await anext(iterator))
        replay = await anext(iterator)
        self.assertIn("event: detection", replay)
        self.assertIn(f"id: {self.store.stream_id}:1", replay)
        await iterator.aclose()
        response = await endpoint(request, after=40, stream_id="replaced")
        iterator = response.body_iterator
        self.assertIn("event: state", await anext(iterator))
        reset = await anext(iterator)
        self.assertIn("event: reset", reset)
        self.assertIn(f"id: {self.store.stream_id}:1", reset)
        await iterator.aclose()

    async def test_graph_adapter_rejects_bad_shape_and_unknown_nodes(self):
        payload = graph(1)
        async def handler(request):
            return httpx.Response(200, json=payload)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            source = GraphSource("http://guard/api/graph", client)
            self.assertEqual(await source.read(), payload)
            payload["nodes"].append(deepcopy(payload["nodes"][0]))
            with self.assertRaises(ValueError):
                await source.read()
            payload["nodes"].pop()
            payload["schema_version"] = "bad"
            with self.assertRaises(Exception):
                await source.read()

    async def test_service_failure_breaks_confirmation_and_retains_active(self):
        counter = 0
        base = datetime.now(timezone.utc) - timedelta(seconds=2)
        async def read():
            nonlocal counter
            counter += 1
            return graph(counter, at=base + timedelta(milliseconds=counter * 100))
        source = SimpleNamespace(read=read)
        service = Investigator(self.store, source)
        await service.tick(); await service.tick()
        async def failed():
            raise OSError("offline")
        source.read = failed
        await service.tick()
        self.assertEqual(self.store.state()["source"]["status"], "unavailable")
        source.read = read
        await service.tick(); await service.tick()
        self.assertEqual(self.store.cursor(), 0)
        await service.tick()
        self.assertEqual(self.store.cursor(), 1)
        source.read = failed
        await service.tick()
        self.assertEqual(self.store.state()["active_count"], 1)

    async def test_startup_does_not_wait_for_guardroom(self):
        def offline(request):
            raise httpx.ConnectError("offline")
        app = create_app(db_path=Path(self.temp.name) / "startup.db", transport=httpx.MockTransport(offline))
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://inv") as client:
                await asyncio.sleep(0.01)
                self.assertEqual((await client.get("/health/ready")).status_code, 200)
                self.assertEqual((await client.get("/v1/state")).json()["source"]["status"], "unavailable")
                self.assertEqual((await client.post("/v1/investigations")).status_code, 503)


if __name__ == "__main__":
    unittest.main()
