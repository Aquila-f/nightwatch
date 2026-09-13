"""Observation orchestration; detection is not an AI investigation."""
import asyncio
import logging

from .models import ObservationStatus, now
from .preprocessor import Preprocessor

LOG = logging.getLogger(__name__)


class Investigator:
    def __init__(self, store, source, poll_seconds=5):
        self.store, self.source, self.poll_seconds = store, source, poll_seconds
        self.preprocessor = Preprocessor()
        self.observation = ObservationStatus(message="服務啟動，等待新觀測").model_dump()
        self.store.commit(None, [], self.observation)

    async def tick(self):
        try:
            graph = await self.source.read()
            status, changes = self.preprocessor.observe(graph, self.store.get("checkpoint"), self.store.active())
            accepted = status in {"ok", "duplicate"}
            observation = {**self.observation, "status": "ok" if accepted else status, "checked_at": now(),
                           "message": {"ok": "持續觀測中", "duplicate": "尚無新的快照",
                                       "stale": "觀測過期或 log 來源不可用；暫停異常與恢復確認",
                                       "out_of_order": "忽略時間倒退的觀測"}[status]}
            if accepted:
                observation.update(last_success_at=now(), snapshot_at=graph["at"], snapshot_seq=graph["seq"])
            self.store.commit(graph if status == "ok" else None, changes, observation)
            self.observation = observation
        except Exception as error:
            self.preprocessor.reset()
            LOG.warning("Observation failed (%s)", type(error).__name__)
            observation = {**self.observation, "status": "unavailable", "checked_at": now(),
                           "message": "無法取得或保存合法 graph；暫停異常與恢復確認"}
            self.store.commit(None, [], observation)
            self.observation = observation

    async def run(self):
        while True:
            try:
                await self.tick()
            except Exception:
                LOG.exception("Unable to persist observation status; retrying")
            await asyncio.sleep(self.poll_seconds)
