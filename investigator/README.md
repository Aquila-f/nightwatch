# NightWatch Investigator

獨立的 graph 觀測與異常偵測服務。每 5 秒透過 HTTP 讀 Guard Room，按節點確認連續三次異常／恢復，保存偵測依據與可續傳事件。

目前沒有 AI loop、模型呼叫、thinking、report 或修復能力。手動建立調查回 `503 runner_unavailable`，不建立等待中的假調查。舊版模型程式已移除，舊 SQLite 資料不遷移、不刪除。

## 啟動

整套服務：

```sh
./restart.sh
```

只建置及啟動 Guard Room、Investigator：

```sh
./guardroom/deploy/restart.sh
```

本機開發使用兩個終端，先依 [Guard Room guide](../guardroom/backend/README.md) 啟動資料來源，再執行：

```sh
uv sync --project investigator --locked
NIGHTWATCH_GRAPH_URL=http://127.0.0.1:9999/api/graph \
  investigator/.venv/bin/python -m uvicorn nightwatch_investigator.api:app \
  --host 127.0.0.1 --port 9998 --workers 1
```

| 環境變數 | 預設／用途 |
| --- | --- |
| `NIGHTWATCH_GRAPH_URL` | `http://127.0.0.1:9999/api/graph`；只接受即時 HTTP(S) graph，不接受 query |
| `INVESTIGATOR_SOURCE_ID` | `guardroom`；DB 的來源身份，換成不同來源必須換 DB |
| `INVESTIGATOR_DB` | `investigator/.data/investigator.sqlite3` |
| `INVESTIGATOR_POLL_SECONDS` | `5`；可設為大於 0、至多 5 秒 |

Compose 使用內網 `http://guardroom:9999/api/graph`，Investigator 不發布 host port。自己的 named volume 保存 SQLite，Guard Room 不掛載它。兩個服務可獨立啟動；readiness 不等待對方。

## API 與語意

瀏覽器只連 Guard Room。此服務 API 供 Guard Room 使用：

| Endpoint | 行為 |
| --- | --- |
| `GET /health/ready` | DB 可讀、HTTP 可用；不表示 graph 來源正常 |
| `GET /v1/state` | 一致的 state、cursor、stream_id、來源狀態、最近 20 筆偵測 |
| `GET /v1/detections?limit=100&before=...` | 依建立 cursor 由新到舊分頁 |
| `GET /v1/detections/{id}` | 完整觸發／恢復快照與連續確認依據 |
| `GET /v1/events?after=0&stream_id=...` | 依 cursor 遞增；next_after 與 has_more 續傳 |
| `GET /v1/investigations` | 空清單，runner_available=false |
| `POST /v1/investigations` | 503，尚未接入 Runner |

同一節點持續異常只建立一筆 detection；其他節點獨立確認。連續三次新鮮的 `ok` 才標為 `recovered`，之後可重新觸發。不存在、unknown、來源離線與過期資料都不算恢復。恢復是節點監測狀態正常，並非根因結論、人工修復或業務驗證。

Snapshot 必須在現在前 15 秒至後 5 秒之間，logstore 必須可用且 age_secs ≤ 60。重複快照不計數；倒序、超過 15 秒的觀測間隔、graph gap、來源錯誤會打斷連續確認。來源 sequence 重設但時間前進時重新累計；程序重啟也重新累計，已保存的 active detection 與 cursor 保留。

僅 polling 最新快照，**不補讀歷史缺口**；短於 polling 間隔的變化可能漏過。Graph 快照窗口重疊，三次確認不是三組獨立請求樣本。

## 開發與驗證

```sh
PYTHONPATH=investigator:guardroom/backend \
  investigator/.venv/bin/python -m unittest discover -s tests/investigator -v
node --test guardroom/frontend/tests/*.test.mjs
PYTHONPATH=investigator:guardroom/backend \
  investigator/.venv/bin/python tests/acceptance/detection_flow.py
```

驗收使用隔離的臨時資料、真實本機 HTTP 服務與合成 monitor 事件，不連模型、不修改使用者的 Shop 或執行中服務。

架構與下一階段的 Runner 接入方式見 [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md)；正式服務契約見 [contracts/INVESTIGATOR.md](../contracts/INVESTIGATOR.md)。
