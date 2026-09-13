"""One process owns the SQLite journal; state and events commit together."""
import fcntl
import json
from pathlib import Path
import sqlite3
from uuid import uuid4

from .models import Detection, DetectionDetail, Event, State, now


def encode(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


class Store:
    def __init__(self, path, source_id):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = Path(str(path) + ".lock").open("a")
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.db = sqlite3.connect(path, check_same_thread=False)
            self.db.row_factory = sqlite3.Row
            self.db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS detections (
                    id TEXT PRIMARY KEY, node_id TEXT NOT NULL, status TEXT NOT NULL,
                    created_cursor INTEGER NOT NULL, detail TEXT NOT NULL);
                CREATE UNIQUE INDEX IF NOT EXISTS active_node ON detections(node_id) WHERE status='active';
                CREATE TABLE IF NOT EXISTS events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);
            """)
            previous = self.get("source_id")
            if previous is not None and previous != source_id:
                raise ValueError("Database belongs to another source_id; use a separate database")
            with self.db:
                self.put("source_id", source_id)
                if self.get("stream_id") is None:
                    self.put("stream_id", "stream-" + uuid4().hex)
        except Exception:
            if hasattr(self, "db"):
                self.db.close()
            self.lock.close()
            raise
        self.source_id = source_id
        self.stream_id = self.get("stream_id")

    def get(self, key):
        row = self.db.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def put(self, key, value):
        self.db.execute("INSERT OR REPLACE INTO metadata VALUES (?,?)", (key, encode(value)))

    def close(self):
        self.db.close()
        self.lock.close()

    def active(self):
        return {row["node_id"]: json.loads(row["detail"]) for row in
                self.db.execute("SELECT node_id, detail FROM detections WHERE status='active'")}

    def commit(self, graph, changes, observation):
        with self.db:
            for change in changes:
                node, action = change["node_id"], change["action"]
                cursor = self.db.execute("INSERT INTO events(body) VALUES ('{}')").lastrowid
                if action == "created":
                    detail = DetectionDetail(id="det-" + uuid4().hex, source_id=self.source_id,
                        node_id=node, status="active", detected_at=graph["at"], event_seq=1,
                        created_cursor=cursor, summary=f"{node} 連續 {len(change['confirmations'])} 次新觀測異常",
                        confirmations=change["confirmations"], snapshot=graph).model_dump()
                else:
                    detail = self.active()[node]
                    detail.update(status="recovered", recovered_at=graph["at"], event_seq=detail["event_seq"] + 1,
                                  recovery_confirmations=change["confirmations"], recovery_snapshot=graph)
                summary = self.summary(detail)
                event = Event(event_id="evt-" + uuid4().hex, cursor=cursor, detection_id=detail["id"],
                              seq=detail["event_seq"], occurred_at=now(), type="detection." + action,
                              payload=Detection.model_validate(summary)).model_dump()
                self.db.execute("UPDATE events SET body=? WHERE cursor=?", (encode(event), cursor))
                self.db.execute("INSERT OR REPLACE INTO detections VALUES (?,?,?,?,?)",
                                (detail["id"], node, detail["status"], detail["created_cursor"], encode(detail)))
            if graph is not None:
                self.put("checkpoint", {"seq": graph["seq"], "at": graph["at"]})
            self.put("observation", observation)

    @staticmethod
    def summary(detail):
        return {key: detail[key] for key in Detection.model_fields}

    def cursor(self):
        return self.db.execute("SELECT COALESCE(MAX(cursor),0) FROM events").fetchone()[0]

    def state(self):
        # Synchronous reads on the single event loop cannot interleave with commit().
        return State(stream_id=self.stream_id, cursor=self.cursor(), server_now=now(),
                     source=self.get("observation") or {},
                     active_count=self.db.execute("SELECT COUNT(*) FROM detections WHERE status='active'").fetchone()[0],
                     recent_detections=self.list(20)["items"]).model_dump()

    def list(self, limit=100, before=None):
        rows = self.db.execute("SELECT detail FROM detections WHERE created_cursor < ? ORDER BY created_cursor DESC LIMIT ?",
                               (before if before is not None else self.cursor() + 1, limit + 1)).fetchall()
        items = [self.summary(json.loads(row[0])) for row in rows[:limit]]
        return {"items": items, "next_before": items[-1]["created_cursor"] if len(rows) > limit else None}

    def detail(self, identifier):
        row = self.db.execute("SELECT detail FROM detections WHERE id=?", (identifier,)).fetchone()
        return json.loads(row[0]) if row else None

    def events(self, after, limit=100):
        if after > self.cursor():
            raise ValueError("Cursor is ahead of the journal")
        rows = self.db.execute("SELECT body FROM events WHERE cursor>? ORDER BY cursor LIMIT ?", (after, limit + 1)).fetchall()
        items = [json.loads(row[0]) for row in rows[:limit]]
        return {"stream_id": self.stream_id, "items": items,
                "next_after": items[-1]["cursor"] if items else after, "has_more": len(rows) > limit}
