"""Isolated real HTTP acceptance: monitor ingestion → graph → detection → Guard Room.

Uses temporary data and dynamically allocated ports, never the user's live Shop.
Optional --browser-script runs a Node browser check against the temporary Console.
"""
import argparse
from contextlib import ExitStack
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
from uuid import uuid4

import httpx

ROOT = Path(__file__).resolve().parents[2]


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)


def wait_for(check, description, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = check()
            if value:
                return value
        except (httpx.HTTPError, KeyError):
            pass
        time.sleep(0.2)
    raise AssertionError("Timed out: " + description)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser-script")
    args = parser.parse_args()
    with TemporaryDirectory(prefix="nightwatch-detection-") as directory, ExitStack() as stack:
        scratch = Path(directory)
        guard_port, inv_port, console_port = port(), port(), port()
        while len({guard_port, inv_port, console_port}) != 3:
            guard_port, inv_port, console_port = port(), port(), port()
        guard_url, inv_url = f"http://127.0.0.1:{guard_port}", f"http://127.0.0.1:{inv_port}"
        config = {"version": 1, "monitor_log": str(scratch / "monitor.jsonl"),
                  "snapshot_path": str(scratch / "graph.json"), "window_seconds": 2,
                  "history": {"directory": str(scratch / "history"), "interval_seconds": 1, "retention_seconds": 60},
                  "monitors": [{"monitor_id": key, "node_id": key} for key in ("a", "b")], "edges": []}
        config_path = scratch / "config.json"
        config_path.write_text(json.dumps(config))
        env = {**os.environ, "GUARDROOM_CONFIG": str(config_path), "INVESTIGATOR_URL": inv_url,
               "NIGHTWATCH_GRAPH_URL": guard_url + "/api/graph", "INVESTIGATOR_DB": str(scratch / "investigator.sqlite3"),
               "INVESTIGATOR_SOURCE_ID": "acceptance", "INVESTIGATOR_POLL_SECONDS": "0.25",
               "PYTHONPATH": str(ROOT / "investigator") + os.pathsep + str(ROOT / "guardroom/backend")}
        def spawn(name, command):
            output = stack.enter_context((scratch / f"{name}.log").open("a"))
            process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT)
            stack.callback(stop, process)
            return process
        guard = spawn("guardroom", [sys.executable, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(guard_port)])
        def start_investigator():
            return spawn("investigator", [sys.executable, "-m", "uvicorn", "nightwatch_investigator.api:app", "--host", "127.0.0.1", "--port", str(inv_port)])
        client = stack.enter_context(httpx.Client(timeout=5, trust_env=False))
        try:
            wait_for(lambda: client.get(guard_url + "/health/ready").status_code == 200, "Guard Room ready without Investigator")
            offline = client.get(guard_url + "/api/investigator/state").json()
            assert not offline["investigator"]["available"] and offline["graph"]["nodes"]
            investigator = start_investigator()
            wait_for(lambda: client.get(inv_url + "/health/ready").status_code == 200, "Investigator ready")

            def feed(a="error", b="ok"):
                logs = [{"schema_version": "nightwatch.log.v1", "event_id": uuid4().hex, "monitor_id": node,
                         "occurred_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                         "level": "ERROR" if status == "error" else "INFO", "message": f"acceptance {node}: {status}",
                         "refs": {"node_ids": [node]}, "attributes": {"kind": "finished", "status": status, "duration_ms": 2.0}}
                        for node, status in (("a", a), ("b", b))]
                response = client.post(guard_url + "/api/logs", json={"logs": logs})
                response.raise_for_status()

            def wait_detection(predicate, a="error", b="ok"):
                def check():
                    feed(a, b)
                    rows = client.get(guard_url + "/api/detections").json()["items"]
                    return rows if predicate(rows) else None
                return wait_for(check, "detection transition")

            rows = wait_detection(lambda rows: len(rows) == 1 and rows[0]["status"] == "active")
            first = rows[0]
            detail = client.get(guard_url + "/api/detections/" + first["id"]).json()
            assert len(detail["confirmations"]) == 3 and detail["snapshot"]["nodes"][0]["status"] == "failing"
            assert client.post(guard_url + "/api/investigations", json={}).status_code == 503
            before = client.get(inv_url + "/v1/state").json()
            stop(investigator)
            offline = client.get(guard_url + "/api/investigator/state").json()
            assert not offline["investigator"]["available"] and offline["graph"]["seq"] >= detail["snapshot"]["seq"]
            investigator = start_investigator()
            wait_for(lambda: client.get(inv_url + "/health/ready").status_code == 200, "Investigator restart")
            restarted = client.get(inv_url + "/v1/state").json()
            assert restarted["stream_id"] == before["stream_id"] and restarted["cursor"] == before["cursor"]
            rows = wait_detection(lambda rows: len(rows) == 2, b="error")
            assert len([row for row in rows if row["node_id"] == "a"]) == 1
            rows = wait_detection(lambda rows: any(row["node_id"] == "a" and row["status"] == "recovered" for row in rows), a="ok", b="error")
            assert next(row for row in rows if row["node_id"] == "b")["status"] == "active"
            # Actual SSE replay, read through Guard Room's HTTP boundary.
            with client.stream("GET", guard_url + "/api/investigator/stream", params={"stream_id": before["stream_id"], "after": 0}) as response:
                response.raise_for_status()
                seen = []
                kind = None
                for line in response.iter_lines():
                    if line.startswith("event: "):
                        kind = line[7:]
                    if line.startswith("data: ") and kind == "detection":
                        seen.append(json.loads(line[6:]))
                        if len(seen) == 3:
                            break
                assert [event["cursor"] for event in seen] == [1, 2, 3]
                assert seen[-1]["type"] == "detection.recovered"
            if args.browser_script:
                subprocess.run([sys.executable, "guardroom/frontend/build.py"], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
                spawn("console", [sys.executable, "guardroom/frontend/serve.py", "--port", str(console_port), "--control-url", guard_url])
                base_url = f"http://127.0.0.1:{console_port}"
                wait_for(lambda: client.get(base_url + "/__console/config").status_code == 200, "Console ready")
                subprocess.run(["node", args.browser_script], cwd=ROOT, env={**env, "ACCEPTANCE_CONSOLE_URL": base_url}, check=True, timeout=60)
            assert guard.poll() is None and investigator.poll() is None
            print("PASS: real HTTP ingestion, per-node detection/recovery, offline graph, restart deduplication, SSE replay, disabled runner", flush=True)
        except Exception:
            for log in scratch.glob("*.log"):
                print(f"--- {log.name} ---\n{log.read_text()[-8000:]}", file=sys.stderr)
            raise


if __name__ == "__main__":
    main()
