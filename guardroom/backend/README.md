# Guard Room HTTP server

提供 monitor graph、logs、歷史快照與前端資料整合。Investigator 是獨立服務；本程序沒有模型依賴或調查資料庫。

## 啟動

```sh
./guardroom/deploy/restart.sh
```

本機開發先選擇未使用的 port，再在 repo 根目錄執行：

```sh
uv sync --project guardroom/backend --locked
INVESTIGATOR_URL=http://127.0.0.1:9998 \
  guardroom/backend/.venv/bin/python -m uvicorn main:app \
  --app-dir guardroom/backend --host 127.0.0.1 --port 9999 --workers 1
```

Investigator 的啟動見 [獨立服務指南](../../investigator/README.md)。

| 變數 | 用途 |
| --- | --- |
| `GUARDROOM_CONFIG` | 預設 `guardroom/configs/shop.json`；monitor→node 與保存路徑 |
| `INVESTIGATOR_URL` | 預設 `http://127.0.0.1:9998`；Compose 使用 `http://investigator:9998` |

## API

| 路徑 | 行為 |
| --- | --- |
| `GET /health`、`GET /health/ready` | HTTP 存活／本地 graph 與 history 排程就緒，不等待 Investigator |
| `GET /api/graph` | 最新 graph；timestamp 查歷史 |
| `GET /api/graph/snapshots` | limit、before_seq 分頁 |
| `POST /api/logs` | 接收、去重、保存並推播 monitor logs |
| `GET /api/debug/logs` | service、limit 查近期保留 logs |
| `GET /events` | 本地 state、graph、log、ping；不讀遠端調查 DB |
| `GET /api/investigator/state` | 本地 graph＋遠端偵測 state 與來源可用性 |
| `GET /api/investigator/stream` | state、reset、detection、source_error、ping；支援續傳 |
| `GET /api/investigator/events` | stream_id、after、limit 讀持久化事件 |
| `GET /api/detections` | limit、before 分頁讀偵測摘要 |
| `GET /api/detections/{id}` | 觸發與恢復的完整觀測依據 |
| `POST /api/investigations` | 503 runner_unavailable；不建立調查 |

舊 /api/state、readiness、capabilities 保留 monitor 投影；舊 /api/incidents 為空。舊模型調查的 detail／report／context／export 路由已移除。舊調查 DB 不開啟、不刪除、不自動遷移。

Guard Room 對 Investigator 的讀取有 2 秒 timeout、4 MiB 上限與 JSON Schema 驗證。暫時離線時 state 仍回傳本地 graph 與最後成功取得的偵測 state，明確標記 available=false；歷史詳情無法取得時回 503。每條前端 SSE 約每 2 秒 polling 一頁遠端事件，重連不跳過已保存事件。

契約與一致性語意見 [INVESTIGATOR.md](../../contracts/INVESTIGATOR.md)。目前沒有 AI thinking／report，也沒有故障修復工具。
