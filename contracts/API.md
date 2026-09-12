# 契約 1:control 對外 API(前端 ↔ control)

> 2026-09-11 新增 runtime 修復投影，細節見
> [Runtime 修復最小 PoC](../docs/runtime-remediation-poc-spec.md)。批准端點與 request_id／
> proposal_id 不變；proposal 增加 commands、attempt、max_attempts、expected_result_zh、
> source，incident 增加 repair_attempts。驗證與重查透過既有 SSE／state 傳遞。
> 前端須顯示批准的確切操作与執行／驗證結果；舊 proposal 沒有新欄位時仍可讀。

這份文件定義 agent 後端(以下叫 control)對前端開的 HTTP 與推播介面。前端只認這份;control 只照這份實作。名稱或形狀有衝突時,以這份與 `schemas/` 為準。**改契約只有協調者能改**,實作的人把需求寫在交接回報裡。

同目錄的另外兩份:
- `SHOP-INTERNAL.md`:control 怎麼對店面下指令(注入故障、修復)。
- `METRICS.md`:店面吐出什麼量測、control 用什麼查詢去讀。

`schemas/*.schema.json` 是機器可驗的版本,`examples/*.json` 是每個 schema 一份最小合法範例,`bun contracts/check.ts` 會全部檢查一遍。

---

## 0. 一句話:整個系統在證明什麼

故障是慢慢爛的。control 每 5 秒對整個店面拍一張「服務圖快照」;偵測到異常就開一件事故,把偵測前十分鐘的快照釘住;模型(agent)用唯讀工具回看那些快照與 trace、log,說出根因與「什麼時候開始壞」;Go 用同一份量測稽核它;人按批准後 Go 才去修;修完等系統穩下來、量兩個 20 秒窗口;最後報告頁把「AI 標的起點、量測到的偏離、注入腳本的真實時刻」放在同一條時間軸上。

---

## 1. 名詞與識別

| 名詞 | 值域 | 說明 |
|---|---|---|
| node id | `storefront` `catalog` `cart` `checkout` `payment` `shipping` `fulfillment` `shopper` `postgres` `orders-queue` `shipping-audit` `payment-provider-primary` `payment-provider-secondary` | 來自 `manifest.yaml`。小寫、連字號。OTel 的 `service.name` 與 node id 相同 |
| kind | `service` `datastore` `queue` `volume` `synthetic` `external` | 節點種類 |
| axis(五軸) | `traffic` `errors` `latency` `saturation` `liveness` | 每個節點每 5 秒量這五個 |
| status(健康) | `ok` `warning` `failing` `unknown` | **Go 算**,前端只顯示 |
| assessment(判定) | `unassessed` `suspect` `ruled_out` `origin` | agent 的判定經 Go 投影;跟 status 是兩個獨立維度,畫面不能用同一套顏色 |
| trend | `rising` `falling` `flat` `na` | 過去 120 秒的方向,Go 算 |
| edge kind | `calls` `uses` `publishes` `consumes` | `calls` 由 trace 觀測;其餘由 manifest 宣告 |
| phase | `baseline` `detected` `investigating` `awaiting_approval` `executing` `verifying` `recovered` `unresolved` `closed` | 事故階段 |
| outcome | `recovered` `recovered_mitigated` `expired_before_approval` `expired_before_execution` `aborted_by_operator` `audit_rejected` `verification_failed` `action_failed` `budget_exhausted` `no_remediation_path` `safety_restore_failed` `unresolved` | 一輪的結局 |
| card id | `catalog_pool_leak` `payment_provider_degradation` `fulfillment_backlog` `audit_debug_logging` `checkout_decoy_combo` | 來自 `cards.yaml` |
| revision | `v1`(出廠值)、`v2`(故障卡上線的版本) | 店面每個服務的執行期設定版本,字串 |

**時間表示。** API 上所有絕對時間都是 RFC3339 UTC(`at`、`*_at`、`server_now`)。事故脈絡下(釘住的快照、工具結果、時間軸、報告)另外附相對秒數 `t`:整數,相對於 `incident.detected_at`,負數是偵測前。轉換只在 Go 做。**模型只看得到 `t`,永遠看不到絕對時間與注入時刻**。

**飽和度單位。** API 上 `saturation` 是 0..1 的比例;畫面顯示百分比整數。

---

### manifest 與 cards 載入時的驗證(任一項不過 → control 啟動失敗、印哪一條)

| 檢查 | 條件 |
|---|---|
| 節點 | `id` 不重複;`kind` 是六種之一;queue / volume 有 `owner` 且指到存在的 service |
| 邊 | `from` `to` 都指到存在的節點 |
| checks | `url` 用到的服務名存在 |
| actions | `targets[]` 是存在的節點;`families[]` 都在 `mechanism_families` 裡;`steps[].kind` 是 `put_config` / `set_knob` / `http_post` |
| cards | `knobs[].service` 存在;`curve.type` 是 `const` / `linear` / `exp` / `step` 四種之一;`lease_secs > 900`;`truth.root`、`expected_order[]` 都是存在的節點;`truth.expected_action` 對得到 `actions[]` |

`curve_unit`(卡片目錄與曲線縮圖用)由旋鈕名決定:`db.leak_per_minute` → `connections/min`;`*_ms` 結尾 → `ms`;`*error_rate` → `ratio`;字串旋鈕(`audit.verbosity`、`provider.active`)→ `level`。

---

## 2. 埠、服務名、環境變數

### compose 內部(容器互相叫的名字)

| 服務 | 內部位址 | 對外(主機 IP:port) |
|---|---|---|
| frontend-proxy(官方店面入口) | `http://frontend-proxy:8080` | `:18080` |
| frontend / product-catalog / cart / checkout / payment / currency / shipping / quote / email / recommendation / ad / image-provider | 各服務的官方 container port;見 `hackathon/contracts/adapter.yaml` health 位址 | 無 |
| load-generator / accounting / fraud-detection | 無 HTTP 入口 | 無 |
| demo-adapter | `http://demo-adapter:8080` | 無,只在 compose network 內 |
| astronomy-db / valkey-cart / kafka | `astronomy-db:5432` / `valkey-cart:6379` / `kafka:9092` | 無 |
| flagd | `flagd:8013`(evaluation)、`:8016`(OFREP) | 無 |
| otel-collector | `otel-collector:4317`(gRPC)、`:4318`(HTTP) | 無 |
| prometheus | `http://prometheus:9090` | `127.0.0.1:9090` |
| jaeger | `http://jaeger:16686`(查詢 API 與 UI) | `:16686` |
| nightwatch-control | `http://nightwatch-control:3000`(公開 API + 前端頁面)、`:3001`(只收 log 與告警,不對外) | `:3000` |

frontend-proxy、control、Jaeger 對外 port 綁 `NIGHTWATCH_BIND_IP`,不綁 0.0.0.0;範本見 `hackathon/oteldemo/.env.example`,`up.sh` 會產生執行期設定。Prometheus 只綁 `127.0.0.1`。demo-adapter 的 8080 不 publish 到主機。

### 主機開發期的埠(避免互撞;主機 8080 已被別的程式佔用,不要用)

| 東西 | 埠 |
|---|---|
| control 在主機直接跑 | `NIGHTWATCH_CONTROL_ADDR=127.0.0.1:3300`、內部 `NIGHTWATCH_CONTROL_INTERNAL_ADDR=127.0.0.1:3301` |
| 假 Prometheus / 假 Jaeger / 假店面(`stubs/fake-stack.ts`) | `127.0.0.1:19090` / `:19686` / `:19080` |
| 假 control(`stubs/mock-control.ts`,播 fixture) | `127.0.0.1:3999` |
| 前端 dev server(`stubs/dev-server.ts`) | `127.0.0.1:5173` |

主機上的 control 對完整 oteldemo stack 用 `NIGHTWATCH_PROMETHEUS_URL=http://127.0.0.1:9090`、`NIGHTWATCH_JAEGER_URL=http://<NIGHTWATCH_BIND_IP>:16686`。runtime config 一律經 demo-adapter,不直接叫官方服務。

### 程式的位置(部署要編映像用)

control 是 Go module `nightwatch/control`,main 在 `hackathon/control/cmd/nightwatch-control`。demo-adapter 是 Go module `nightwatch/demo-adapter`,main 在 `hackathon/demo-adapter/cmd/demo-adapter`。兩者都要 `CGO_ENABLED=0 GOOS=linux` 編得過。官方 Demo 服務直接使用 `ghcr.io/open-telemetry/demo:3.0.0-<service>` 預編映像,不再編 `hackathon/shop`。

### control 的環境變數

| 變數 | 意思 |
|---|---|
| `NIGHTWATCH_CONTROL_ADDR` | 公開埠,預設 `:3000` |
| `NIGHTWATCH_CONTROL_INTERNAL_ADDR` | 內部埠,預設 `:3001` |
| `NIGHTWATCH_PROMETHEUS_URL` | 例 `http://prometheus:9090` |
| `NIGHTWATCH_JAEGER_URL` | 例 `http://jaeger:16686` |
| `NIGHTWATCH_MANIFEST` / `NIGHTWATCH_CARDS` | 兩個 yaml 的路徑 |
| `NIGHTWATCH_STATE_DIR` | 落地目錄(事故檔、環形快照) |
| `NIGHTWATCH_SHOP_URL_TEMPLATE` | oteldemo stack 固定 `http://demo-adapter:8080/%s`;主機假店面仍可用 `http://127.0.0.1:19080/svc/%s` |
| `NIGHTWATCH_LLM_ENDPOINT` / `NIGHTWATCH_LLM_MODEL` / `NIGHTWATCH_LLM_API_KEY` / `NIGHTWATCH_LLM_REASONING_EFFORT` | 模型;endpoint 是 OpenAI Responses 介面 `https://api.openai.com/v1/responses` |
| `NIGHTWATCH_MODEL_OFFLINE=1` | 不打模型,事故只偵測不排查 |
| `NIGHTWATCH_BASELINE_AUTO=1` | 開發用:基線不用等 120 秒,收到第一張快照就 ready(接 1、接 3 排練用) |
| `NIGHTWATCH_SHOP_URLS` | 主機開發期:服務名→位址的對照表,逗號分隔(見上);優先於 `NIGHTWATCH_SHOP_URL_TEMPLATE` |
| 模型金鑰的來源 | 部署腳本從 repo 根的 `.env` 讀 `OPENAI_API_KEY`,以 `NIGHTWATCH_LLM_API_KEY` 交給 control;金鑰不寫進 compose 檔、不印在 log、不出現在任何 API 回應 |
| `NIGHTWATCH_ROUNDS_ALWAYS=1` | 開發用:還沒有事故也允許 `POST /api/rounds`(control 04 測換輪用;05 之後可拿掉) |
| `NIGHTWATCH_GUARDROOM_URL` | oteldemo stack 留空;不啟用 Guard Room |
| `NIGHTWATCH_PUBLIC_HOST` | 組 `capabilities.links` 用的主機位址;storefront link 指 frontend-proxy 的 `:18080`,Jaeger 指 `:16686`,沒有 Grafana 就填 null |

---

## 3. control REST 端點

所有回應 JSON。錯誤統一:

```json
{"error": {"code": "incident_active", "message_zh": "事故進行中,不能注入", "details": {}}}
```

錯誤碼固定這些:`incident_active` `round_not_ready` `round_not_needed`(基線期還沒有事故就按「開始下一輪」)`fault_active` `card_unknown` `proposal_stale` `approval_not_allowed` `cleanup_not_verified` `chat_busy` `model_unavailable` `invalid_request` `not_found` `internal`。

寫入類 POST 都吃 `request_id`(冪等鍵):同一個 `request_id` 重送,回同一個結果,不重做。

優先序:**必要** = 第一張卡走完整輪一定要有;**其次** = 第二張卡或報告頁要用;**有空** = 時間夠再做。

| 方法 路徑 | 優先 | 用途 | 回應要點 |
|---|---|---|---|
| `GET /health` | 必要 | control 活著 | `{"status":"ok"}` |
| `GET /api/readiness` | 必要 | 現在能不能按故障卡 | `readiness.schema.json`;`checks[]` 每項 `id` `status`(`ok|waiting|failed`)`detail_zh`;`next_step_zh` 一句話寫現在該做什麼 |
| `GET /api/state` | 必要 | 整份投影,三個頁面共用 | §4 |
| `GET /events?cursor=<run_id>:<revision>` | 必要 | SSE 推播 | §4 |
| `GET /api/graph` | 必要 | 現在這張快照 | `snapshot.schema.json`,不帶 `t` |
| `GET /api/graph?at=<RFC3339>` | 其次 | ≤ 該時刻最近一張 | 同上;環形裡沒有 ≤ 該時刻的快照 → 404 `not_found` |
| `GET /api/graph/history?node=&window_secs=` | 必要 | 一個節點的降採樣序列 | `history.schema.json`;`window_secs` 60–900,超出回 400 `invalid_request` |
| `GET /api/debug/logs?service=&limit=` | 開發用 | 讀回 logstore 最近的幾行(對名、確認 collector 有送到) | `[{time, service, severity, body, trace_id}]`,`limit` 預設 20 |
| `GET /api/faults/catalog` | 必要 | 五張卡的公開資料(**不含 truth、不含 knobs**) | `fault-catalog.schema.json`;每張含 `curve_preview`(固定 24 點 `[t_secs, value]`,值照 `SHOP-INTERNAL.md` §3 的公式算;`examples/fault-catalog.json` 裡的數字只是形狀示意,不是期望值)、`curve_unit`、`curve_knob`、`expect.detect_after_secs` |
| `POST /api/faults` | 必要 | 注入一張卡 | body `{"request_id","card_id","lease_secs"?}`;202 `{"instance_id","operation_id"}`;409 `incident_active` / `round_not_ready` / `fault_active`;404 `card_unknown` |
| `GET /api/faults/instances` | 必要 | 現在有哪些故障實例 | 整個 `faults.schema.json` 物件 `{"instances":[…],"generation":n}`,跟 state 裡的 `faults` 同一份 |

故障實例的狀態機補充:曲線推送對店面 `PUT /internal/config` **連續 5 次失敗** → 實例 `status: unknown`(畫面顯示「店面沒回應」),下一次成功再回 `active`;lease 到期或還原時 PUT 失敗 → `restore_failed`。

| `POST /api/faults/instances/{id}/restore` | 其次 | 單張還原(不算修復) | 202 |
| `POST /api/faults/restore-all` | 必要 | 安全清理 | body `{"request_id","force":bool}`;202 |
| `POST /api/rounds` | 必要 | 開始下一輪(不重啟) | body `{"request_id"}`;202 `{"run_id","operation_id"}`;409 `cleanup_not_verified` |
| `GET /api/rounds/operations/{id}` | 其次 | 輪替進度 | `{"status":"running|done|failed","step_zh"}` |
| `GET /api/incidents/{id}` | 必要 | 事故 read model | §6 |
| `GET /api/incidents/{id}/snapshots` | 其次 | 釘住的快照集合 | `{"pinned_window":{"from","to","from_t","to_t","count"},"snapshots":[快照,帶 t]}` |
| `GET /api/incidents/{id}/timeline` | 其次 | 三層時間軸 | `timeline.schema.json` |
| `GET /api/incidents/{id}/report` | 其次 | 報告物件 | `report.schema.json` |
| `POST /api/incidents/{id}/approve` | 必要 | 批准目前提案 | body `{"request_id","proposal_id"}`;202;`proposal_id` 不是目前提案 → 409 `proposal_stale`;不在 `awaiting_approval` → 409 `approval_not_allowed` |
| `POST /api/incidents/{id}/abort` | 其次 | 操作員中止,還原故障 | 202;結局 `aborted_by_operator` |
| `GET /api/capabilities` | 必要 | 靜態能力表 | §4 的 `capabilities` |
| `POST /api/chat/messages` | 有空 | 講者打字問 agent | body `{"text"}`;`{"reply_zh","tool_calls":[]}`;409 `incident_active` / `chat_busy`;503 `model_unavailable` |
| `GET /api/incidents` | 有空 | 歷史事故清單(報告頁的空狀態與切換) | `[{"id","card_id","phase","outcome","detected_at","closed_at"}]`,新的在前 |
| `GET /api/incidents/{id}/events` | 有空 | 一件事故的完整 journal(結案後看明細用) | `incident-commit.schema.json` 的陣列,依 revision 遞增;沒有這個端點時前端用 SSE `cursor=<run_id>:0` 重播代替 |
| SSE `chat` 事件 | 有空 | 對話回覆串流 | `{"message_id","seq","text_zh","done","by":"model"\|"system"}`;`by=model` 的字畫面要標成模型寫的;有串流時 `POST /api/chat/messages` 回 202 `{"message_id"}` |
| `POST /internal/otlp/v1/logs` | 必要 | collector 推 log(OTLP/HTTP JSON) | 只在 `:3001`;回 200 `{}` |
| `POST /internal/alerts/grafana` | 有空 | Grafana 告警當第二偵測來源 | 只在 `:3001`;204 |
| `GET /`、其他非 `/api` 的 GET | 必要 | 前端頁面(把 `console/dist` 嵌進 control 執行檔) | 找不到檔案回 `index.html`;沒 build 前端時回一頁純文字「前端未 build」 |

---

## 4. `/api/state` 與 SSE

`/api/state` 是三個頁面共用的一份投影。形狀在 `state.schema.json`,範例在 `examples/state.json`:

```json
{
  "schema_version": "nightwatch.state.v2",
  "server_now": "2026-09-10T13:42:05Z",
  "run": {"id": "run-…", "started_at": "…", "baseline": {"status": "collecting|ready", "collected_secs": 45, "required_secs": 120}},
  "readiness": { …同 GET /api/readiness… },
  "model": {"available": true, "model": "gpt-5.6-luna", "effort": "medium"},
  "graph_now": { …snapshot,不帶 t… },
  "faults": {"instances": [ … ], "generation": 7},
  "incident": { …§6,或 null… },
  "capabilities": {
    "max_calls": 20, "hard_timeout_secs": 900,
    "tools": [{"name": "get_node_history", "description_zh": "一個節點在一段時間內五個量的變化", "parameters": [{"name": "node", "type": "string", "range_zh": "manifest 的 node id"}, {"name": "window_secs", "type": "integer", "range_zh": "60–900"}]}, …九個],
    "actions": [ …manifest 的動作表… ],
    "nodes": [{"id": "catalog", "kind": "service", "layout": {"row": 1, "col": 0}, "sat_label": "pool"}, …13 個,直接來自 manifest],
    "links": {"storefront": "http://<host>:18080", "jaeger": "http://<host>:16686", "grafana": null}
  },
  "next_step_zh": "可以按故障卡"
}
```

`capabilities.nodes` 就是前端畫服務圖用的固定版面:13 個節點、各自的列與欄。前端不自己排版。

### SSE `GET /events`

`event:` 名稱 → `data:` JSON:

| event | 何時推 | data |
|---|---|---|
| `state` | 連線時、換輪之後 | 整份 `/api/state` |
| `graph` | 每 5 秒 | 一張快照(`snapshot.schema.json`) |
| `incident` | 事故每寫一筆事件 | 一筆 commit(`incident-commit.schema.json`):`event` + 這筆改到的欄位 |
| `faults` | 故障實例變化、曲線進度每 10 秒 | `faults` 物件(`faults.schema.json`) |
| `readiness` | 變化時 | readiness 物件 |
| `run` | 換輪 | `{"run_id"}`;前端整頁重新拉 `/api/state` |

每 2 秒送 `event: ping`、data `{"server_now":"…"}`。**是事件,不是 `: ping` 註解行**:瀏覽器的 EventSource 看不到註解行,前端把 ping 算成活動。前端 6 秒沒任何事件 → `stale`、15 秒 → `disconnected`(接 0 的時候就是因為這個對不上)。

**cursor 只追蹤 `incident`**:前端斷線重連時帶 `?cursor=<run_id>:<最後收到的 revision>`,control 先送一份 `state`,再把 revision 之後的 `incident` commit 依序補上。沒有 run id 時不帶 cursor(帶 `:0` 這種要回 400)。

`faults.instances[]` 每筆(`faults.schema.json`):`instance_id` `card_id` `status`(`applying|active|restoring|restored|expired|aborted|unknown|restore_failed`)`revision` `applied_at` `expires_at` `curve_progress`(0..1)`elapsed_secs` `ttl_remaining_secs` `detected_after_secs`(偵測到時 = detected_at − applied_at,否則 null)`mitigated`(付款卡切備援後 true)`owned_resources`(`["config:catalog"]`)。後面四個由 control 每次送出時重算。

---

## 5. 節點、邊、快照、歷史

節點(`node.schema.json`):

```json
{
  "id": "catalog", "kind": "service",
  "traffic": 30.2, "errors": 0.031, "p95_ms": 1180, "saturation": 0.96, "alive": true,
  "sat_label": "pool", "primary_axis": "saturation",
  "status": "failing", "assessment": "origin",
  "trend": {"errors": "rising", "latency": "rising", "saturation": "rising"},
  "extras": {"pool_in_use": 12, "pool_max": 12, "pool_wait_total": 87},
  "revision": "v2",
  "checks": ["catalog_products_probe"], "logs_indexed": true
}
```

- 五軸任一沒資料就是 `null`,不是 0。`sat_label` 說明飽和度量的是什麼:`pool` `queue` `disk` `mem`,沒有就 `""`。
- `primary_axis`:Go 挑「目前最異常的一軸」給前端顯示在節點上;`alive=false` → `liveness`;否則 failing 的軸(依 errors → latency → saturation);否則帶外且 rising 的軸;否則 `null`。
- `extras` 鍵名固定:service/datastore 的 `pool_in_use` `pool_max` `pool_wait_total`;queue 的 `depth` `oldest_age_secs` `enqueue_per_s` `dequeue_per_s`;volume 的 `used_ratio` `write_p95_ms` `write_errors_total` `enospc_total`;service 的 `top_error_spans` `top_slow_spans`(最多 3);synthetic 的 `orders_per_s` `fail_ratio` `fail_reasons`。
- `revision` 只有 service 類有。
- **沒有量測資料的節點**(例如店面那邊還沒實作出貨):五軸 `null`、`status: unknown`、`alive` 跟著 health_url(service)或 owner(queue/volume)。不能因為沒資料就判成死掉。

邊(`edge.schema.json`):`{"from":"checkout","to":"catalog","kind":"calls","rps":12.2,"errors":0.032,"p95_ms":1200,"observed":true}`。`observed:false` = manifest 宣告過但 30 秒內沒流量。

快照(`snapshot.schema.json`):`schema_version` `seq`(單調遞增)`at` `t`(只在事故脈絡)`nodes[]` `edges[]` `sources{prometheus,jaeger,logstore:{ok,age_secs}}` `gap_before`(control 重啟造成的缺口,`{from,to}` 或 null)。每 5 秒一張,環形保留 15 分鐘(180 張)。

歷史(`history.schema.json`;給 `get_node_history` 與畫面):

```json
{"node": "catalog", "kind": "service", "t_from": -600, "t_to": 45, "step_secs": 25,
 "axes": ["t", "rps", "err", "p95", "sat", "up"],
 "points": [[-600, 29.8, 0.0, 140, 44, 1], [-575, 30.1, 0.0, 142, 45, 1]],
 "baseline": {"rps": 30.0, "err": 0.0, "p95": 141, "sat": 45},
 "band": {"err_max": 2.0, "p95_max": 212, "sat_max": 60},
 "sat_label": "pool"}
```

points 裡 `err` 與 `sat` 是百分比、`p95` 毫秒、`up` 0/1;最多 26 個點,`step = ceil(window/25)` 秒對齊 5 秒;每格 err/p95/sat 取中位數、rps 取平均。

### 就緒(readiness)的八項檢查

| id | ok 的條件 | detail_zh 例 |
|---|---|---|
| `prometheus_reachable` | 最近一次查詢成功 | 「Prometheus 正常」/「連不上 …」 |
| `jaeger_reachable` | `GET /api/services` 回 200 | |
| `logstore_receiving` | 最近 60 秒有收到 log | 「60 秒內沒有 log,檢查 collector 的 exporter」 |
| `nodes_alive` | manifest 裡**目前有在跑的** service 節點都 alive(接 2、接 3 時店面只起一部份,只看有出現過量測的服務) | 列出還沒活的服務名 |
| `shopper_rate` | 合成顧客 ≥ 1 單/秒 | |
| `baseline` | 基線收滿(120 秒 / 24 張;之後是滑動窗,不會再變紅) | 「基線收集中 45/120 秒」 |
| `model` | 啟動時探測模型端點成功 | 「離線,本輪只偵測不排查」 |
| `fault_clear` | 沒有 active 的故障實例 | 「故障進行中:<卡名>」 |

`ready` = 八項全 ok(`model` 例外:failed 時其他都 ok 也算 ready,但走離線路徑)。`next_step_zh` 只有這幾種文字:「等待服務啟動」→「基線收集中 N/120 秒」→「可以按故障卡」;`model` failed 時「模型不可用,本輪只偵測不排查」;有故障時「故障進行中:<卡名>」;結案後「已結案,按『開始下一輪』」。

沒數字的節點(店面那個服務還沒起來、Prometheus 還沒有它的量測):五軸 `null`、`status: unknown`、`trend: na`,畫面畫灰、顯示「無資料」;**不算 failing、不擋 readiness、不觸發偵測**。

logstore:control 在內部埠收 OTLP/HTTP JSON 的 log,環形保留 **15 分鐘或 20,000 行**(先到為準);快照的 `logs_indexed` = 最近 15 分鐘有沒有這個 service 的 log;`sources.logs.ok` = 最近 60 秒有收到。

### 基線、偏離帶、健康分類、趨勢(Go 一份函式,四處共用)

- **基線**:每節點每軸取 24 張快照(120 秒)的中位數。收滿之前 `baseline` 那項不 ready。**收滿之後不凍結**,窗持續往前滾,但有兩個保護:最新 6 張(30 秒)先不納入,而且上一張快照只要有任何節點 `failing` 就整拍不收、也不重算(參考值停在故障發生前)。下一輪重收。
- **偏離帶**:`err_max = baseline.err + 0.02`;`p95_max = max(baseline.p95 × 1.5, baseline.p95 + 50ms)`;`sat_max = baseline.sat + 0.15`。
- **偏離時間 dev(node, axis)**:第一個「連續 2 張」都在帶外的樣本的 t(liveness 軸:第一張 `alive=false`)。
- **status**:`failing` = errors ≥ max(0.05, baseline.err + 0.02)、或 p95 ≥ 3× baseline 且 ≥ 500ms、或 saturation ≥ 0.9、或 not alive;`warning` = 任一軸在帶外或任一軸 rising;`ok` = 其他;`unknown` = 沒任何軸有資料。
- **trend**:過去 120 秒(24 張)線性回歸;`斜率 × 120s ÷ baseline > +25%` 記 rising、`< −25%` falling、否則 flat;baseline 為 0 的軸用絕對門檻(errors +0.02、saturation +0.10)。

### 偵測規則

| 規則 | 條件 | 連續 |
|---|---|---|
| R1 訂單失敗率 | 60 秒內 shopper 訂單 ≥ 10 且失敗比 ≥ max(0.05, baseline + 0.02) | 3 張 |
| R2 訂單延遲 | shopper 拿到 `fulfilled` 的 p95 ≥ 3× baseline 且 ≥ 1500 ms | 3 張 |
| R3 節點死亡 | 任一 service / datastore / queue / volume 節點 `alive=false`(external 與 synthetic 不算) | 3 張 |

結案後偵測關閉,直到 `POST /api/rounds`。

---

服務圖下方的小折線(顧客錯誤率):前端從每 5 秒一次的 `graph` 事件累積 `shopper` 節點的 errors 軸,最多留 120 點(10 分鐘);每一格是「過去 30 秒的平均」,不是瞬間值。這條線只在前端算,control 不另外提供端點。

沒數字的時候怎麼表示:軸(`traffic` `errors` `latency_p95_ms` `saturation` 這些)可以是 `null`,代表這一刻查不到;**`extras` 裡的鍵查不到就不要出現**,不要填 `null`(schema 規定 extras 的值是數字)。來源全掛時 `extras` 是空物件。

## 6. 事故 read model 與 journal

`GET /api/state.incident` 與 `GET /api/incidents/{id}` 回同一個形狀(**攤平**,不要再包一層):

```json
{
  "id": "inc-…", "run_id": "run-…", "phase": "awaiting_approval", "outcome": null,
  "detected_at": "…", "closed_at": null, "card_id": "",
  "pinned_window": {"from": "…", "to": "…", "from_t": -600, "to_t": 45, "count": 129},
  "detection": {"source": "builtin_graph", "rule": "R1", "signals": [ … ], "summary_zh": "合成顧客的訂單失敗率 30%(基線 0%,門檻 5%)"},
  "nodes": [{"id": "catalog", "status": "failing", "assessment": "origin"}, …],
  "evidence": [{"id": "ev-0001", "tool": "get_node_history", "source": "graph", "t": 3, "summary_zh": "…"}],
  "hypothesis": { …§7 agent 報告,或 null… },
  "audit": {"status": "passed", "timeline_status": "accepted", "checks": [{"id": "evidence_integrity", "status": "passed", "reason": ""}, …]},
  "proposal": {"id": "prop-…", "action": "rollback_config", "target": "catalog", "description_zh": "把 catalog 的執行設定回滾到 v1", "scope_zh": "只動 catalog 的設定", "evidence_ids": ["ev-0003"], "verify_zh": "兩個 20 秒窗口:顧客失敗率回帶內、catalog 池用量 ≤ 4"},
  "approval": {"status": "approved", "proposal_id": "prop-…", "at": "…"},
  "execution": {"status": "done", "steps": [{"kind": "put_config", "target": "catalog", "revision": "v1", "ok": true}]},
  "verification": {"windows": [{"index": 1, "passed": true, "observed": {"shopper_fail_ratio": 0.0, "catalog_pool_in_use": 2}}], "safety_recovery": false},
  "usage": {"calls": 5, "elapsed_secs": 38, "input_tokens": 15700, "cached_tokens": 9300, "output_tokens": 325},
  "revision": 41
}
```

`card_id` 結案前是 `""`,結案後才填(給報告頁揭曉)。`revision` 是 journal 的最新序號,SSE cursor 用。 每筆 SSE commit 帶 `base_revision`(套用前的版本,等於上一筆 commit 的 `revision`)與 `revision`(套用後);前端手上的 revision 不等於 `base_revision` 就代表漏了一筆,重拉 `/api/state`。

journal 事件種類(每筆事件都有 `id` `seq` `type` `occurred_at` `t` `actor{kind,id}` `timeline{title,summary_zh}`,可帶 `refs{node_ids,evidence_ids}` 與 `payload`):

| 誰寫 | 事件種類 |
|---|---|
| 回合與基線 | `run.started` `baseline.captured` |
| 故障引擎 | `fault.activated` `fault.instance.changed` `fault.restored` `fault.lease_expired` `config.revision_changed` |
| 偵測 | `incident.detected` `detection.corroborated` `snapshot.pinned` `investigation.started` |
| 模型迴圈 | `tool.started` `observation.recorded` `model.turn_failed` `hypothesis.concluded` |
| 稽核、提案、執行 | `action.proposed` `approval.recorded` `action.started` `action.completed` `operator.aborted` |
| 驗證與結案 | `verification.window_completed` `verification.completed` `incident.completed` |
| 加分 | `graph.gap` |

沒有事故時(故障引擎、回合、基線的事件)掛在 run 層級:commit 的 `incident_id` 是 `""`。

畫面最常用的兩筆:
- `tool.started` 的 payload:`call_id` `tool` `args` `note_zh`(模型自己寫的一句「我要查什麼」)。
- `observation.recorded` 的 payload:`call_id` `tool` `duration_ms` `source`(`prometheus|jaeger|logstore|http|graph`)`result`(§8 的投影)`evidence_ids` `usage{round:{input_tokens,cached_tokens,output_tokens}}`。
- `hypothesis.concluded` 的 payload:`hypothesis`(§7)。`action.proposed` 的 payload:`proposal`。

`actor.kind` ∈ `go` `model` `tool` `operator` `grafana`。前端用它標「模型撰寫」還是「Go 產生」。

事故階段轉移:`baseline → detected → investigating → awaiting_approval → executing → verifying → recovered`;中途出事落到 `unresolved`。模型在 investigating 用完預算或連續三輪失敗:outcome `budget_exhausted` 或 `unresolved`,phase 直接 `closed`。

---

### 畫面上的中文(三個畫面共用,不要各自翻)

| phase | 標題 |
|---|---|
| `baseline` | 基線收集中 |
| `detected` | 偵測到異常 |
| `investigating` | 排查中 |
| `awaiting_approval` | 等待批准 |
| `executing` | 執行修復中 |
| `verifying` | 驗證中 |
| `recovered` | 已修復 |
| `unresolved` | 未解決 |
| `closed` | 已結案 |

| outcome | 標籤 |
|---|---|
| `recovered` | 已修復 |
| `expired_before_approval` | 批准前逾時 |
| `expired_before_execution` | 執行前逾時 |
| `aborted_by_operator` | 操作者中止 |
| `audit_rejected` | 稽核未通過 |
| `verification_failed` | 驗證失敗 |
| `action_failed` | 動作失敗 |
| `budget_exhausted` | 預算用完 |
| `no_remediation_path` | 沒有可用的修復 |
| `safety_restore_failed` | 安全還原失敗 |
| `unresolved` | 未解決 |
| `recovered_mitigated` | 已繞過(根因還在) |

journal 事件的 `actor.kind`:`go` → 「系統」、`model` → 「模型」、`tool` → 「工具」、`operator` → 「操作者」、`grafana` → 「Grafana 告警」。

「正在查 X」的規則:排查中,畫面顯示最近一筆 `tool.started` 的 `args.node`(或 `service`)當作「正在查的對象」,直到同一個 `call_id` 的 `observation.recorded` 到了才換下一個;沒有進行中的工具呼叫就顯示「整理中」。

## 7. agent 報告、時間軸、報告物件

模型交的 JSON(`agent-report.schema.json`),單行、無 prose:

```json
{"root_cause":{"node":"catalog","mechanism":"postgres connection pool exhausted: in-use climbed to pool max, queries queued then timed out","summary_zh":"catalog 的資料庫連線池從偵測前兩分鐘開始被佔滿,查詢排隊後逾時,checkout 與 storefront 的錯誤都是從這裡傳上去的。"},
 "confidence":0.85,"cited_evidence_ids":["ev-0002","ev-0003","ev-0007"],
 "timeline":{"onset":{"node":"catalog","t":-135,"signal":"sat","evidence_id":"ev-0003"},
             "propagation":[{"node":"catalog","t":-135,"signal":"sat"},{"node":"checkout","t":-25,"signal":"err"},{"node":"storefront","t":-5,"signal":"err"}]},
 "contributing":[],
 "ruled_out":[{"node":"payment","reason":"contained","evidence_id":"ev-0007"}]}
```

`signal ∈ err|p95|sat|up`;`contributing[].role ∈ secondary|decoy`;`ruled_out[].reason ∈ contained|no_deviation|downstream_of_root`。沒結論時回一句 `inconclusive: <reason>`。

六項稽核(Go 做;前三項決定能不能提案,第四、五項只決定報告頁採不採信 AI 標的時間軸;第六項只在 Guard Room 開著時才判,預設不擋提案):

| id | 在確認什麼 |
|---|---|
| `evidence_integrity` | 引用的證據編號都存在於這件事故 |
| `direct_origin` | Go 自己從 trace 與服務圖算「最上游的可疑節點」,只能有一個,且等於 `root_cause.node`(external 節點映射到呼叫它的服務、queue/volume 映射到 owner;synthetic 不算候選) |
| `cause_action` | (root node, mechanism 關鍵字 → family)在 manifest `actions[]` 對得到一個動作 |
| `timeline_onset` | onset 的節點等於 root;引用的證據是一筆該節點的 `get_node_history` 且 t 在其範圍內;與量測偏離時間差 ≤ 30 秒;t ≤ 0 |
| `timeline_order` | propagation 第一筆是 onset;t 非遞減;每筆與量測偏離差 ≤ 30 秒;順序與量測一致;每筆沿服務圖呼叫更早的某筆 |
| `error_log_cited` | `cited_event_ids` 裡至少一筆是根因節點的 Guard Room 錯誤日誌。沒接 Guard Room(`NIGHTWATCH_GUARDROOM_URL` 空)或本事故沒用過 `list_errors` / `get_node_errors` → `skipped` |

**動作是 Go 從 manifest 對照表查出來的,不採用模型自己講的動作名稱。** 六項稽核各自怎麼判、external / queue / volume 怎麼映射、驗證窗與結局怎麼定,全部在 `AGENT.md`。

`GET /api/incidents/{id}/timeline`(`timeline.schema.json`):`system[]`(每筆 `t` `seq` `kind` `label_zh`,工具事件 `kind:"tool"` 另帶 `tool` `node`)、`ai{status,onset,propagation,reasons?}`、`measured{deviations[{node,axis,t}]}`、`truth{card_id,t_injected,curve}`(**只在結案後出現**)。

`GET /api/incidents/{id}/report`(`report.schema.json`):`outcome` `counted_recovery_success` `durations{inject_to_detect_secs,detect_to_close_secs,approve_to_verified_secs}` `root_cause` `confidence` `audit` `ai_timeline` `measured` `truth` `comparison{ai_onset_minus_truth_secs,ai_onset_minus_measured_secs,detect_minus_truth_secs,detect_minus_ai_onset_secs}` `early_sign{seq,t,node,axis,value,errors_then}` `action` `verification` `residual[]` `pinned_window`。**全部由 Go 算,前端只顯示。**

---

## 8. agent 工具契約(畫面要渲染工具卡,所以列在這)

| 工具 | 參數 | 回傳(給畫面與模型同一份) | byte 上限 |
|---|---|---|---|
| `get_node_history` | `node`,`window_secs` 60–900 | §5 history | 3072 |
| `get_node_detail` | `node` | `{node, kind, t, now:{traffic,errors,p95_ms,saturation,alive}, extras, edges_out[], edges_in[], checks[], logs_indexed}` | 2048 |
| `find_traces` | `service`,`mode` error/slow/any,`window_secs` 15–900,`limit` 1–20 | `{t_from,t_to,traces:[{trace_id,t,duration_ms,status,root_span,services[]}]}`(實際最多 3 筆) | 4096 |
| `get_trace` | `trace_id` 32 hex | `{path_kind, path[], error_services[], slow_services[], contained[]}` | 8192 |
| `search_logs` | `service`,`min_severity` 0–24,`window_secs` 15–900,`contains` ≤200 | `{t_from,t_to,total,patterns:[{sample,count,first_t,last_t,severity}]}` | 4096 |
| `query_metric` | `template_id` ∈ `node.request_rate` `node.error_rate` `node.self_error_rate` `node.p95_ms` `node.saturation`,`node`,`window_secs` | `{value, baseline_value, delta, unit, freshness_secs}` | 1024 |
| `run_health_check` | `check_id`(manifest) | `{check_id, status, http_status, latency_ms, detail_zh}` | 2048 |
| `list_errors` | `from_t` `to_t` 相對秒數 −900–900(可省),`limit` 1–50 | Guard Room 全叢集錯誤日誌,由舊到新(找誰先錯);每筆帶 `event_id` | 8192 |
| `get_node_errors` | `node`(有 Monitor 的節點),`limit` 1–20 | Guard Room 單一節點的錯誤日誌,由新到舊(看它自己說了什麼);每筆帶 `event_id` | 6144 |

最後兩個是 Guard Room 的工具:只有 `NIGHTWATCH_GUARDROOM_URL` 有設時才會出現在 `capabilities.tools` 與送給模型的 `tools` 裡,沒設就是前七個。它們固定排在最後,因為工具定義是 prompt cache 前綴的一部分,插在中間會讓整個前綴失效。

參數範圍在 Go 先檢查,超出範圍的呼叫連後端都不碰。工具內部怎麼算(截斷標記、trace 攤平、log 聚合、程序門檻、預算)在 `AGENT.md` §1 §2。每次呼叫的結果存成一筆證據(`ev-0001`…),模型之後只能用這些編號引用。一輪上限:20 次呼叫、15 分鐘、40 萬 token。

---

## 9. fixture(離線回放用的資料)

`contracts/fixtures/<card_id>/`:

| 檔 | 內容 |
|---|---|
| `state.initial.json` | 注入前、基線 ready、無事故的 `/api/state` |
| `state.json` | 結案後的 `/api/state` |
| `events.jsonl` | 每行 `{"event":"incident"|"graph"|"faults"|"readiness","data":{…}}`,依 data 內的時間排序 |
| `snapshots.jsonl` | 釘住集合,每行一張快照(帶 t) |
| `report.json` | `/api/incidents/{id}/report` |
| `timeline.json` | `/api/incidents/{id}/timeline` |

`catalog_pool_leak` 這組是從真的一輪錄下來的,前端在 control 做出來之前就靠它開發;control 結案時要能用 `NIGHTWATCH_RECORD_FIXTURES=1` 錄出同樣六個檔。

---

fixture 沒有 history 檔:離線回放時 `history` 由 `snapshots.jsonl` 抽該節點的軸、照 §5 的降採樣規則算出來。

## 10. 版本字串

`nightwatch.state.v2` `nightwatch.snapshot.v2` `nightwatch.manifest.v2` `nightwatch.cards.v2` `nightwatch.incident-commit.v2` `nightwatch.report.v2`。
