# Error Log 與 Guard Room 邊界

## 現在可用的 log

官方服務與 k6 將 OTLP logs 送 `otel-collector`。collector 的 logs pipeline
會先丟棄 body 含 `feature flag` 或 `flagd` 的記錄，再把未壓縮 JSON POST 到
control internal `:3001/internal/otlp`。control logstore 保存精簡欄位：
時間、service、severity、body、trace id。這條流不是第二個偵測來源；graph
metrics 仍決定節點狀態與事故 detection。

Agent 的 `search_logs` 已接上這個 logstore，可用 manifest service id、最低
severity、window 與 contains 查詢。結果會成為 evidence，之後可在 incident
state/report 看到引用。collector 會主動過濾 flagd 題面，因為錯誤內容不能
直接揭露故障卡的 knob 名。

最小檢查順序：

1. `GET /api/readiness` 確認 `logstore_receiving`。
2. 看 [`../METRICS.md`](../METRICS.md) 對應 node 的 Prometheus/graph 訊號。
3. 用 `search_logs` 查 root candidate 的 error/warn aggregate patterns；trace correlation 改用 `find_traces`。
4. 用 `find_traces`/`get_trace` 對同一時間窗交叉確認。

## 現行 Guard Room 狀態

OTel compose 的 `NIGHTWATCH_GUARDROOM_URL` 目前留空，所以 Guard Room error
projection disabled。control 的 Guard Room client、`list_errors`、
`get_node_errors`、edge sync、audit 與 capabilities 分支已存在；啟用時只需
由 compose 設定 URL 並啟動對應服務。它們不是目前 OTel compose 的可用資料源。

目前可用的是 OTLP logstore；row 沒有 `event_id`、`instance_id`、`invocation_id`、
原始 exception、processed/revision metadata，也不能查 Guard Room 歷史 projection。
不要把 `search_logs` 的 aggregate 稱為 monitor/v1alpha2 event。Agent 在 disabled
時沒有兩個 Guard Room tools，`error_log_cited` 保持 skipped。

## 最小接入方案（推薦，尚未實作）

最小 bridge 是 Guard Room 新增 OTLP/HTTP JSON endpoint
`/internal/otlp/v1/logs`，collector 增加第二個 exporter/pipeline，把 logs 同時
送 control 與 Guard Room；Guard Room 在 endpoint 內把 OTLP record 轉成
`monitor/v1alpha2`。不要求修改官方服務或 demo-adapter，也不要求 control 新增
client/tools/edge sync/audit code；若實測暴露接口缺口才另開最小修正。

| 位置 | MVP 修改 |
| --- | --- |
| `poc-v3/internal/guardroom/http.go` | 新增 `/internal/otlp/v1/logs` JSON receiver |
| `poc-v3/internal/guardroom/otlp_ingest.go`（新增）及對應 `*_test.go` | 解析 OTLP logs、ERROR/FATAL filter、mapping、event id、dedupe |
| `hackathon/oteldemo/otel/collector.yaml` | 增第二 exporter/pipeline，保留既有 control logs pipeline |
| `hackathon/oteldemo/compose.yaml`, `build.sh`, `Dockerfile.guardroom`（新增）, `doctor.sh` | build/run Guard Room、URL、health 與 smoke check |
| official services / demo-adapter / control | 不改；除非驗收確定既有 endpoint 不足 |

wire mapping 直接採用 [`../../../poc-v3/contracts/monitor-event-v1.md`](../../../poc-v3/contracts/monitor-event-v1.md)
的 `monitor/v1alpha2`；Guard Room HTTP 與 graph/errors projection 以
[`../../../poc-v3/contracts/guard-room-api.md`](../../../poc-v3/contracts/guard-room-api.md)
為準。MVP 只轉 ERROR/FATAL，足以解鎖既有 error tools，但不能用 error logs
合成 monitor heartbeat 或 liveness；完整 heartbeat 需要獨立且明確的來源，列為
後續工作。

## 欄位 mapping（推薦方案）

下表是 OTLP log record 到 `monitor/v1alpha2` log event 的建議 mapping。它是
接線設計，不是目前 control 已經接受的第二種輸入格式。

| OTLP 欄位 | event 欄位 | 規則 |
| --- | --- | --- |
| resource `service.name` | envelope `monitor_id` | 由 manifest/registry 做穩定 mapping；log payload 沒有 target 欄位 |
| resource `service.instance.id` | `instance_id` | 有值直接使用；缺少時用 `bridge_boot_id + service.name` 非空 fallback |
| `timeUnixNano` | `payload.occurred_at` | 轉 RFC3339Nano；無效值才用 receiver time |
| `severityText` / number | `payload.level` | 正規化成 TRACE/DEBUG/INFO/WARN/ERROR/FATAL |
| `body.stringValue` | `payload.message` | 保留文字；不把 body 當 JSON 指令執行 |
| `traceId` | `payload.invocation_id` | 優先使用 traceId；缺少時使用同一 event 的 `event_id` |
| `spanId` | `payload.attributes` | 供 trace 關聯，不改寫成新的 trace |
| resource/span attributes | `payload.attributes` | namespace、route、deployment 等原樣保留 |
| 上述穩定欄位 | envelope `event_id` | 對 canonical bytes 做 SHA-256，重試時不變 |

`instance_id` 不可為空；fallback 代表 bridge boot 期間同一 service 的來源，
不代表 upstream 真正的 process instance，報告要保留這個限制。`event_id` 是
先對不含 fallback invocation_id 的 canonical source 欄位做 stable hash，再用該
event_id 補 invocation_id。OTLP 沒有原生 record ID，因此相同欄位的兩筆
事件可能無法區分，bridge 必須記錄此限制。重送同一筆 record 必須得到同一值。
`emitted_at` 是 bridge 發布時間，`occurred_at` 是 OTLP event time；不能互換。
envelope 的 `schema_version`、`type=log`、`emitted_at` 和 `payload` 遵照
[`monitor-event-v1.md`](../../../poc-v3/contracts/monitor-event-v1.md)。

## Filter、去重與重試（推薦方案）

Guard Room bridge 預設只發布 ERROR 與 FATAL；DEBUG、INFO、WARN 仍可留在
control logstore，供 `search_logs` 做 investigation。severity number 與 text
衝突時，bridge 應保留原始值並採用明確、可測試的優先規則，不能把未知值升級成
FATAL。

receiver 以 `event_id` 做冪等去重；網路失敗使用有限次數與退避重試。重試耗盡
要增加 dropped/retry metric 並留下可查的錯誤，不能靜默丟失。MVP 可在現有
in-memory Guard Room 內做 request-level dedupe，但不承諾重啟後 replay。
持久化、有界 queue 和跨重啟恢復是後續 extension，避免 HTTP timeout 造成重複
projection。

未知 service.name 不能自行建立新的 manifest node。推薦做法是送到 quarantine
monitor 或以 unknown target 拒絕並記錄 counter；待 manifest/registry 更新後
再重放。缺少 `service.name` 的 record 同理，不可用 container hostname 猜測
正式 node id。

## 缺 log、容量與 retention

目前 logstore 每次 ingest 只保留最近 15 分鐘，並將記錄上限裁到 20,000 筆；
它只保存 service、severity、body、trace id 等精簡欄位。這能支援短窗
`search_logs`，不等於完整事件保存，也不保證每個服務近期都有 log。

目前 Guard Room 是 in-memory，沒有持久化，也沒有 retention cap；MVP 不應宣稱
跨重啟歷史完整。後續才明訂 bounded/persistent queue、事件 TTL、receiver
retention、單筆 body 上限與 dropped counter；超限時回報容量原因及時間範圍。
保留政策要和 incident audit 的需求分開寫，不能因為 control logstore 有 15
分鐘資料就宣稱歷史 error 完整。

某服務沒有 log 只能表示沒有收到符合條件的 log。它不能被解讀成健康，也不能
覆蓋 metrics、trace 或 health probe 的失敗。readiness 的 `logstore_receiving`
只回答整體 pipeline 最近是否收過資料；service-level absence 必須保持
unknown，並在 Agent evidence 說明來源與時間窗。

## 端到端驗收（推薦 bridge 尚未實作）

實作 bridge 後，應用一筆帶有 service.name、instance、trace/span、ERROR body
與 timeUnixNano 的 OTLP log，並確認：

1. collector 收到並轉發；非 ERROR/FATAL 按規則不發布 Guard Room event。
2. Guard Room API 能讀到 envelope、monitor_id、instance、occurred_at、level、message
   與 attributes，event_id 可重算且相同。
3. 重送同一筆 payload 只產生一個 projection；短暫 5xx 後 retry 最終只出現一個。
4. unknown service 進 quarantine/拒絕路徑；缺 `service.name` 不會冒充 manifest node。
5. logstore、Guard Room、metrics/trace 的時間窗和 retention 結果各自可解釋。
6. Agent 的 error evidence 能引用 event id；目前未接時則明確顯示 skipped。

目前可執行的驗收仍是 `search_logs` 路徑：先跑 `GET /api/readiness`，再由
Agent tool schema 查詢 service、severity、window、contains，並以 Jaeger trace
交叉核對。Guard Room 的 HTTP、projection 和 tools 在加入實作前都屬於推薦設計，
不能寫入「已完成」報告。
