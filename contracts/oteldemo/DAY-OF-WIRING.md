# 比賽當天接線表

這是填寫和驗收流程，不是另一份 manifest。完整現行清單仍見
[`../manifest.yaml`](../manifest.yaml)：19 nodes、24 declared edges。

## 服務 inventory 模板

每個 upstream service/作業填一列；from/to 可是 node id 或 external endpoint。

| from | to | protocol/port | operation | resource attrs | span attrs | health | flag/runtime owner | evidence status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| load-generator | frontend-proxy | HTTP :8080 | checkout journey | service.name=load-generator | http.route/name | k6 metric | flagd wrapper / — | observed |
| frontend-proxy | frontend | HTTP :8080 | `/api/*` proxy | service.name=frontend-proxy | http.route, peer.service | adapter HTTP | — | observed |
| frontend | checkout | gRPC :5050 | checkout RPC (確認 emitted method) | service.name=frontend | rpc.service/method | adapter TCP | — | observed |
| checkout | payment | gRPC :50051 | charge | service.name=checkout | peer.service=payment | adapter TCP | payment / payment | observed |
| product-catalog | astronomy-db | DB client | query | service.name=product-catalog | server.address=astronomy-db, db.system.name=postgresql | adapter TCP | — | declared / observed |
| cart | valkey-cart | Redis client | cart state | service.name=cart | server.address=valkey-cart | adapter TCP | cart / cart | declared |
| checkout | kafka | producer | order event | service.name=checkout | messaging.system=kafka | manifest owner | kafkaQueueProblems / checkout | declared |

上表是已填的代表例，不是完整 edge 清單；resource/span 欄位以實際 emitted
telemetry 為準。新增列前先找 compose env、upstream docs、collector label 和
adapter config 的證據。

## 邊分類

| kind | 意義 | 典型驗證 |
| --- | --- | --- |
| `calls` | request/response service 呼叫 | client/server spans、service graph |
| `uses` | service 使用 datastore | client span selector、receiver metric |
| `publishes` | producer 發布 queue message | producer span、queue metric |
| `consumes` | consumer 讀 queue | consumer lag、consumer span |

只有 manifest 宣告的 edge 進入 control projection。`observed` 是 telemetry 在
該快照是否看見，不是 topology 的存在保證。

## 當天填表順序

以下命令以 repository root 為目前工作目錄；括號內會明確切換到 contracts。

1. 從 compose 列出 service、hostname、container port、healthcheck、依賴和 resource attrs。
2. 對照 upstream image 的 config/env，確認 HTTP/gRPC/DB/queue operation。
3. 用 collector/Prometheus labels 填 span attrs 與 metric selector；用 Jaeger
   搜一筆實際 trace，不要只照服務名稱猜。
4. 將 nodes/edges/checks/selector 寫入 manifest；target health 和 knobs 寫 adapter。
5. 起 stack 後逐項確認 OTLP receiver、Prometheus series、Jaeger service、logstore、health。
6. 跑 `(cd hackathon/contracts && bun check-live.ts http://127.0.0.1:3000)`，再實測一個
   runtime PUT 與一輪批准修復；把結果和時間記錄在報告。

## 分工與合併

| 角色 | 交付 |
| --- | --- |
| upstream/infra | compose、服務 env/ports、collector source evidence |
| adapter | adapter.yaml target、health、flag update、revision telemetry |
| control | manifest-driven snapshot/query、REST/SSE、action/verification |
| Agent/console | tool evidence、proposal/approval rendering、狀態呈現 |
| coordinator | schema、cards、inventory review、live check、merge/patch |

各角色先在自己的目錄驗證，再由 coordinator 以 source-of-truth 檔合併。若
port、service.name、selector 或 owner 不一致，先停合併並修正契約，不在 console
加 fallback 名稱掩蓋問題。

## Definition of Done

- 每個要納入 demo 的 node 有唯一 manifest id、kind、layout、health 或明確 none。
- 每條要畫的 edge 有正確 kind，且至少一筆 trace/metric 證據或標明未觀測。
- OTLP traces/metrics/logs 各自到正確 downstream；來源 health 可解釋。
- load-generator 的 health/liveness 由 k6 metric 或宣告 SLI 說明；不要求 adapter target。
- datastore/queue 可用其 receiver、client span 或 compose evidence；不要求 adapter health target。
- runtime knob 可 GET/PUT、由 OFREP 讀回、以 revision/log 可追溯。
- Agent 只看到宣告工具與 evidence；approval 前沒有 mutation。
- schema、`bun contracts/check.ts`、adapter tests、`check-live.ts` 通過。
- 文件只報已實測範圍；未跑的卡、service 或 Guard Room bridge 明確標示。

## Evidence 填寫欄

每列 inventory 完成後，另外記下：

| 欄位 | 要填的證據 |
| --- | --- |
| compose | service name、image/version、container port、healthcheck、depends_on |
| telemetry | resource `service.name`、instance、route/peer/server attrs、時間 |
| health | probe URL 或 TCP address、status/dial、timeout、實測 timestamp |
| runtime | flagd flag、target、revision、readback、owner、restore value |
| projection | PromQL/Jaeger/log query、response 摘要、是否 observed |

`from`/`to` 使用 manifest id；外部 endpoint 使用完整 hostname/port 並標示
external。resource attrs 和 span attrs 要記實際 key/value 範例，但不要把每次
trace 的動態 id 寫進 manifest。若同一服務有多個 instance，保留 instance id
作 evidence 維度，不複製 node。

## 已填 reference

目前 OTel Demo 參考規模是 19 nodes、24 declared edges；上面的 rows 只故意選
代表性的 service call、datastore、queue 與 runtime owner。完整關係仍從
[`../manifest.yaml`](../manifest.yaml) 讀取。所有 edge 是否在某窗口觀測到，應以
control graph 和 trace/metric evidence 填寫 `observed`，不能由 reference rows
推斷。

## 合併閘門

各角色提交 inventory 時，coordinator 逐項比對 service.name、manifest id、
compose hostname、port、selector、health owner 和 runtime owner。任何一項不一
致都退回 source evidence；不要在 adapter 或 console 補 alias。確認後依序合併
compose/collector、manifest/adapter、schemas/control、cards/Agent 文件，最後
跑 schema check、adapter tests、doctor 和 live check。

若當天沒有足夠 telemetry，仍可合併 compose/health evidence，但該列標成
`declared, unobserved`。Definition of Done 只在 trace、metric、log、health
各自的證據和限制都已保存後才算完成；單一健康 HTTP 回應不能代替端到端資料流。

## Evidence 三層標記

- `declared`：compose、manifest、adapter 或 selector 已宣告，尚未在此次窗口看到資料。
- `observed`：在指定時間窗看到 trace、metric、log 或 health response；只描述觀測值。
- `verified`：依 DoD 的完整查詢、跨 projection 或 runtime/recovery 驗收通過，附命令與時間。

同一列可以同時是 `declared, observed`，但只有附上完整驗收證據才標 `verified`。
health response 只能驗證該 probe；它不會自動驗證 telemetry edge，也不會讓缺失的
metric/log 變成 healthy。inventory 的 status 欄位應保留這三種詞，避免把宣告拓撲、
短暫觀測和端到端驗證混為一談。
