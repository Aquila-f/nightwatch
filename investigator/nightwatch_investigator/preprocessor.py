"""Deterministic, per-node confirmation. Unknown/missing data never means recovery."""
from datetime import datetime, timezone


def instant(value: str) -> datetime:
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("Observation time requires timezone")
    return result


class Preprocessor:
    def __init__(self, confirmations=3, max_age=15, max_gap=15):
        self.confirmations, self.max_age, self.max_gap = confirmations, max_age, max_gap
        self.runs = {}

    def reset(self):
        self.runs.clear()

    def observe(self, graph, checkpoint, active_nodes, at=None):
        at = at or datetime.now(timezone.utc)
        observed = instant(graph["at"])
        source = graph["sources"]["logstore"]
        if not -5 <= (at - observed).total_seconds() <= self.max_age or not source["ok"] or source["age_secs"] > 60:
            self.reset()
            return "stale", []
        if checkpoint:
            previous = instant(checkpoint["at"])
            if graph["seq"] == checkpoint["seq"] and observed == previous:
                return "duplicate", []
            if observed <= previous:
                self.reset()
                return "out_of_order", []
            if graph["seq"] <= checkpoint["seq"] or (observed - previous).total_seconds() > self.max_gap:
                self.reset()
        if graph.get("gap_before"):
            self.reset()
        present = {node["id"] for node in graph["nodes"]}
        self.runs = {key: value for key, value in self.runs.items() if key in present}
        changes = []
        for node in graph["nodes"]:
            key, status = node["id"], node["status"]
            action = ("recovered" if status == "ok" else None) if key in active_nodes else (
                "created" if status in {"warning", "failing"} else None)
            if action is None:
                self.runs.pop(key, None)
                continue
            row = {field: node[field] for field in ("status", "errors", "p95_ms")}
            row.update(seq=graph["seq"], at=graph["at"])
            prior_action, rows = self.runs.get(key, (action, []))
            rows = (rows if prior_action == action else []) + [row]
            self.runs[key] = (action, rows[-self.confirmations:])
            if len(rows) >= self.confirmations:
                changes.append({"node_id": key, "action": action, "confirmations": rows[-self.confirmations:]})
                self.runs.pop(key, None)
        return "ok", changes
