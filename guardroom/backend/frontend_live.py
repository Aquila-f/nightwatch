"""Console projections of local monitor observations. Detection data has its own HTTP boundary."""
from copy import deepcopy
from datetime import datetime
from uuid import uuid4

from time_utils import timestamp


class LiveStore:
    def __init__(self, app, error):
        self.app, self.error = app, error
        self.run = {"id": "live-" + uuid4().hex, "started_at": timestamp(),
                    "baseline": {"status": "collecting", "collected_secs": 0, "required_secs": 120}}

    @property
    def graph_store(self):
        value = getattr(self.app.state, "graph_store", None)
        if value is None:
            raise self.error(503, "internal", "Monitor graph 尚未啟動")
        return value

    def readiness(self):
        source = self.graph_store.snapshot["sources"]["logstore"]
        receiving = source["ok"] and source["age_secs"] <= 60
        reasons = {
            "prometheus_reachable": "尚未接入 Prometheus",
            "jaeger_reachable": "尚未接入 Jaeger",
            "logstore_receiving": "60 秒內有收到 monitor log" if receiving else "60 秒內沒有 monitor log",
            "nodes_alive": "Monitor 活動不等於服務探活；尚未接入 health check",
            "shopper_rate": "尚未接入合成顧客訂單率",
            "baseline": "尚未實作可信基線",
            "model": "AI 調查尚未接入",
            "fault_clear": "尚未接入故障控制，無法確認外部故障是否已清理",
        }
        return {"ready": False, "checks": [
            {"id": key, "status": "ok" if key == "logstore_receiving" and receiving
             else "failed" if key == "model" else "waiting", "detail_zh": reason}
            for key, reason in reasons.items()], "next_step_zh": "等待服務啟動"}

    def capabilities(self):
        return {"nodes": [{"id": node["id"], "kind": node["kind"],
                           "layout": {"row": index // 3, "col": index % 3},
                           "sat_label": node["sat_label"]}
                          for index, node in enumerate(self.graph_store.snapshot["nodes"])],
                "tools": [], "actions": [], "max_calls": 0, "hard_timeout_secs": 0,
                "links": {"storefront": None, "jaeger": None, "grafana": None}}


    def state(self):
        readiness = self.readiness()
        return {"schema_version": "nightwatch.state.v2", "server_now": timestamp(), "run": deepcopy(self.run),
                "readiness": readiness, "model": {"available": False, "model": "", "effort": ""},
                "graph_now": deepcopy(self.graph_store.snapshot),
                "faults": {"instances": [], "generation": 0}, "incident": None,
                "capabilities": self.capabilities(), "next_step_zh": readiness["next_step_zh"]}

    def stream_snapshot(self):
        return self.state(), []

    def read(self, name, params, query):
        if name == "logs":
            rows = []
            for log in self.graph_store.recent.values():
                for node in log["refs"]["node_ids"]:
                    if query.get("service") and node != query["service"]:
                        continue
                    rows.append({"time": log["occurred_at"], "service": node, "severity": log["level"],
                                 "body": log["message"], "trace_id": log.get("attributes", {}).get("trace_id", "")})
            rows.sort(key=lambda row: datetime.fromisoformat(row["time"].replace("Z", "+00:00")), reverse=True)
            return rows[:int(query.get("limit", 20))]
        if name == "incidents":
            return []
        raise self.error(404, "not_found", "舊調查介面已移除；偵測紀錄請使用 /api/detections")
