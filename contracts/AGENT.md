# 契約 4:模型排查、稽核、驗證(control 內部的規則;前端與店面不用讀)

> 2026-09-11 runtime 修復版本：本輪新增與覆蓋規則以
> [Runtime 修復最小 PoC](../docs/runtime-remediation-poc-spec.md) 為準。
> 以下保留舊 action／fixture 契約；其中「只能由機制關鍵字選 action」、卡片專用驗證、
> 重查清空 context 的描述不適用於新 `repair_plan` 流程。

新流程增加唯讀 `inspect_runtime({target})`，回傳 manifest 宣告的操作能力與當前設定。
模型在既有 agent report 加上選填 `repair_plan`，提出具體 `restore_config`、
`patch_config`、`maintenance` 步驟；Go 驗證並解析為不可變的 HTTP 操作提案，人批准後執行。
操作目標、參數與維護路徑由 `manifest.runtime_targets` 定義，模型不能傳任意 URL 或 shell。
`cause_action` 對新計畫檢查參數與證據關聯；舊報告缺少 repair_plan 時保留原 action 相容路徑。

修後依偵測時凍結的 baseline 與真實新快照驗證，最多先等 90 秒恢復，再量兩個各 20 秒的
連續健康窗口；缺資料不算成功。第一次失敗會把 execution／verification 與原 evidence
帶回模型再調查，新提案需要新批准；最多兩次批准執行。成功、第二次失敗、中止、到期都會
有明確結局，不永久停在 verifying。故障卡只用於注入與人工驗收，不作為新計畫的答案來源。

這份講 control 從「偵測到異常」到「結案」中間怎麼做決定:模型怎麼被叫、工具怎麼回、Go 怎麼稽核模型的答案、修完怎麼驗、結局怎麼定。前端只看 `API.md` §6 §7 的投影,店面只看 `SHOP-INTERNAL.md`;這裡的規則只有寫 control 的人要照做。角色分工一句話:**模型只讀、Go 稽核、人批准、Go 執行與驗證。**

## 1. 排查迴圈

### 1.1 訊息怎麼組(prompt cache 為先)

| 部份 | 內容 | 規則 |
|---|---|---|
| 靜態前綴(走 Responses 的 `instructions`,不是 input 的第一則訊息) | 角色與分工;時間規則(一切用 `t`);九個工具的用法(含兩張圖怎麼分工:指標圖看誰偏離、Guard Room 的錯誤日誌圖看節點自己說了什麼);排查程序;傳染規則;「每次呼叫工具前用一句 zh-TW 說你要查什麼」;最後答案的格式(`API.md` §7 的單行 JSON,或 `inconclusive: <原因>`);節點清單、check 清單、`query_metric` 樣板清單(從 manifest 產生) | **每輪 byte-identical**:不能含任何時間、事故 id、回合 id、注入時刻。對同一份 manifest 產生兩次要一模一樣 |
| `prompt_cache_key` | 固定字串(例:`nightwatch-agent-loop-v1`) | 對話模式用另一個固定字串 |
| 開場訊息 | 偵測簡報(規則、訊號、`summary_zh`)+ 目前的節點表 + 釘住視窗的快照**等距抽樣最多 12 張**(`agent.go:110` `openingSnapshotBudget`) | 只在第一輪。整個釘住視窗有 120 張以上,全丟進去約 27 萬 token,而且每一輪都要重送一次 |
| 每一輪追加 | 工具結果 + 更新後的節點表 + `{"calls_used","calls_left","secs_left"}` | **append-only**:不改、不刪舊訊息,只往後加 |

請求本身固定帶:`prompt_cache_key`、`reasoning.effort`、`max_output_tokens`、`store: false`;`cached_tokens` 從 `usage.input_tokens_details.cached_tokens` 讀(不是 `usage.cached_tokens`,那個欄位不存在)。

排查程序(寫進前綴,模型照這個走):先讀節點表 → `get_node_history` 找最早偏離的節點 → `find_traces` + `get_trace` 看誰先出錯 → `get_node_detail` / `query_metric` 說明機制 → 交報告。傳染規則(也寫進前綴):症狀會沿呼叫方向往上傳,呼叫端的偏離一定晚於被呼叫端;**最深、而且自己有偏離**的節點才是根因。

### 1.2 節點表(每輪附上,欄位順序固定)

每個節點一行,欄位順序:`id`、`kind`、`rps`、`err%`、`p95`、`sat`、`up`、`trend`(三字元:`up_` / `dn_` / `flt` / `na_`)、`status`、`assessment` 縮寫(`--` / `sus` / `out` / `org`)。每條邊一行:`from → to (kind) rps err% p95`。沒數字的欄位印 `-`。這張表就是模型看到的「服務圖」,欄位順序改了 prompt cache 就失效,所以定死。

### 1.3 預算、逾時、失敗

| 項目 | 值 | 用完 / 發生時 |
|---|---|---|
| 工具呼叫次數 | 20 | 要求模型立刻交報告;再不交 → outcome `budget_exhausted` |
| 排查時間 | 900 秒 | 同上 |
| token(input + output 累計) | 400,000 | 同上 |
| 單次模型請求逾時 | 60 秒 | 算一次失敗 |
| 連續失敗 | 3 次 | 寫 `model.turn_failed`,outcome `unresolved`,`summary_zh` 帶錯誤原文前 200 字(金鑰遮掉) |
| 模型交的 JSON 壞掉 | — | 回給模型「格式錯,重交」**一次**;再壞 → `unresolved` |
| 參數超出 `API.md` §8 的範圍 | — | 回給模型一句錯誤,不碰後端;算入 20 次的分母 |

### 1.4 程序門檻

交報告前沒有至少**一次成功的 `get_node_history` 加一次成功的 `get_trace`**(`trace_id` 必須來自 `find_traces`),Go 不收這份報告:事故直接以 `unresolved` 結案,理由寫成 `procedure_incomplete:沒有成功的 get_node_history`(缺哪一項就寫哪一項,`agent.go:266-277`)。理由:沒看過歷史就不知道誰先偏離,沒看過 trace 就不知道錯是誰的。

靜態前綴另外要求「交報告前至少一次成功的 `list_errors` 或 `get_node_errors`」,但這條**只寫在提示裡,Go 沒有擋**;實際把關的是 §3 的 `error_log_cited`。

### 1.5 報告怎麼變成 read model

`API.md` §7 的報告解析成功後:`hypothesis` 與 `usage` 更新;`nodes[].assessment` 對照如下,其他節點維持 `unassessed`。

| 報告裡 | assessment |
|---|---|
| `root_cause.node` | `origin` |
| `ruled_out[].node` | `ruled_out` |
| `contributing[].node` | `suspect` |

`inconclusive: <原因>` → outcome `unresolved`、phase `unresolved`。

## 2. 工具的實作規則(補 `API.md` §8 沒說的)

| 工具 | 規則 |
|---|---|
| 全部 | 回傳 JSON 超過 §8 的 byte 上限就截斷,並加 `"truncated": true`;每次結果存一筆證據 `ev-0001`…(`id` `tool` `args` `source` `t` `summary_zh` `result`) |
| `get_node_history` | 從**釘住集合**取,`[now − window, now]` 夾到釘住範圍;降採樣同 `API.md` §5;`t` 相對偵測時刻 |
| `get_node_detail` | 最新快照的節點 + `extras` + 進出邊 + manifest 的 checks + `logs_indexed`;service 類另外**即時**查 `METRICS.md` §3「節點詳情才查」的那兩句,得到 `top_error_spans` / `top_slow_spans` |
| `find_traces` | Jaeger `/api/traces?service=&lookback=&limit=`;`error` 只留有 error tag 的、`slow` 依 duration 降冪、`any` 不篩;每筆算 `t`;最多回 3 筆 |
| `get_trace` | span 樹攤成一條路徑:`path_kind` = `error`(有 error span)否則 `latency`;`path[]` 從根到最深的那個 error / 最慢 span,每段 `{service, span, duration_ms, error}`;`error_services[]` = 自己的 span 有 error 的服務;`contained[]` = 呼叫了 error 的下游、但自己的 span 沒 error 的服務(錯被它吃掉了) |
| `search_logs` | logstore 查完做 pattern 聚合:數字、uuid、hex 正規化成 `#` 後分組;最多 8 個 pattern,各帶 `sample` `count` `first_t` `last_t` `severity` |
| `query_metric` | 五個樣板對 `METRICS.md` §3 的句子;`baseline_value` 用基線;`delta` = value − baseline;`unit` 照軸;`freshness_secs` = 現在 − 最近一次成功取樣 |
| `run_health_check` | manifest `checks[]` 的 url(經主機位址對照改寫),3 次、每次 2 秒逾時,回 `{check_id, status: ok|failed, http_status, latency_ms, detail_zh}` |
| `list_errors` | Guard Room `GET /errors`;由舊到新,`limit` 預設要小(上限 8192 byte,約 30 列),訊息比 `get_node_errors` 截得更短;每筆帶 `event_id`,模型只能引用這裡拿到的編號 |
| `get_node_errors` | Guard Room `GET /monitors/{id}/errors`;由新到舊,上限 6144 byte;`node` 只接受有 Monitor 的節點(manifest 裡 `service` 與 `synthetic` 那些) |

## 3. 六項稽核(模型交報告後,Go 做)

每項寫 `{id, status: passed|failed|skipped, reason}`;`reason` 要寫得出「拿什麼跟什麼比」,報告頁會原樣顯示。

| id | 怎麼判 |
|---|---|
| `evidence_integrity` | `cited_evidence_ids` 非空,且每個都在這件事故的 `evidence[]` |
| `direct_origin` | 候選集 = trace 裡非 `contained` 的 error / slow 節點 ∪ 最新快照 `failing` 的節點 − 模型 `ruled_out` 的節點。**先映射**:external 節點 → 宣告邊裡呼叫它的 service;queue / volume → `owner`;synthetic 剔除。取呼叫圖(觀測邊 + 宣告邊)上「到不了其他候選」的葉子;必須恰好一個,且等於映射後的 `root_cause.node`。`reason` 寫候選集與葉子 |
| `cause_action` | `root_cause.mechanism` 小寫比對 manifest `mechanism_families[].keywords` → family;`actions[]` 裡 `families` 含該 family 且 `targets` 含 root(volume / queue 用 owner)的那個動作;對不到 → failed |
| `timeline_onset` | 照 `API.md` §7:onset 節點 = root;引用的證據是該節點的一筆 `get_node_history` 且 t 在範圍內;與量測的 `dev(node, axis)` 差 ≤ 30 秒;t ≤ 0 |
| `timeline_order` | 照 `API.md` §7 五條;**最後一條(root 的偏離不能晚於任何 propagation 節點 10 秒以上)失敗時,`direct_origin` 也標 failed** |
| `error_log_cited` | `cited_event_ids` 裡至少一筆是根因節點(external / queue / volume 先映射到 owner)的 Guard Room 錯誤日誌。沒接 Guard Room → `skipped`;本事故沒有 `list_errors` / `get_node_errors` 的證據 → `skipped` |

`audit.status` = 前三項全 passed;`audit.timeline_status` = 第四、五項全 passed → `accepted`,否則 `rejected`(只影響報告頁採不採信 AI 的時間軸)。`audit.status` failed → outcome `audit_rejected`、phase `unresolved`。

`error_log_cited` **預設不計入 `audit.status`**:它 failed 也照樣提案,只是報告頁看得到。要它擋提案得設 `NIGHTWATCH_GUARDROOM_AUDIT_STRICT=1`(`control/internal/server/server.go:221`)。前端不要自己數「幾項全過」當總體判定,`audit.checks` 是動態長度,照後端的 `audit.status` 顯示。

`dev(node, axis)` 用 `API.md` §5 那組純函式對釘住集合算。

誘餌:`cards.yaml` 的 `truth.decoys` 只給報告頁揭曉用,**不給模型、不影響稽核**;模型要自己從 trace 與偏離順序分辨誰是誘餌。

## 4. 動作解析與提案

動作永遠是 Go 從 manifest 查出來的,不用模型講的動作名。提案內容:`{id, action, target, description_zh(manifest 的 description_zh 把 {target} 換掉), scope_zh, evidence_ids(模型引用的), verify_zh(這張卡會怎麼驗), mitigation_only}`。`mitigation_only` 來自 manifest 的動作定義(例:切換付款供應商只是繞過)。

執行步驟照 `SHOP-INTERNAL.md` §4;每步結果進 `execution.steps[]`(`{kind, target, ok, detail}`);任一步失敗 → outcome `action_failed`。動作成功後:回滾類動作把對應的故障實例標 `restored`,**曲線引擎停止推那張卡的旋鈕**;`mitigation_only` 的動作實例維持 `active` 並標 `mitigated: true`,曲線**繼續推**(主供應商還是壞的,這是刻意的)。

## 5. 驗證與結局

### 5.1 流程

1. 執行完進 `verifying`,先等系統穩:最多 `cards.yaml` 的 `verify.settle_max_secs`(預設 40 秒);期間每張快照跑通用謂詞,一過就進窗口,超時也進。
2. **兩個連續 20 秒窗口**,窗口內每張快照都要同時過通用謂詞與卡片謂詞;每個窗口寫 `verification.window_completed`(`{index, passed, observed:{shopper_fail_ratio, shopper_p95_ms, <卡片謂詞的值>}}`)。
3. 兩個都過 → `verification.completed` + `incident.completed`。

### 5.2 謂詞

| 謂詞 | 過的條件 |
|---|---|
| 通用 | shopper 的 errors 與 p95 都回到基線帶內;沒有任何節點 `status = failing` |
| `node_extra_below {node, extra, max}` | 該節點 `extras[extra] ≤ max` |
| `node_extra_monotonic_down {node, extra, max?}` | 窗口內序列不上升(容許雜訊:相鄰兩張差 ≤ 序列首值的 5% 不算上升);有給 `max` 時,「全程 ≤ max」也算過(已經降到底就不必再降) |
| `node_axis_in_band {node, axis}` | 該節點該軸在基線帶內 |

### 5.3 結局怎麼定

| 情況 | outcome | phase |
|---|---|---|
| 兩窗全過,動作是回滾類 | `recovered` | `recovered` |
| 兩窗全過,動作是 `mitigation_only` | `recovered_mitigated`;`residual[]` 列 status ≠ ok 的節點與一句 `note_zh` | `recovered` |
| 任一窗口有一張不過 | `verification_failed` | `unresolved` |
| lease 在 `awaiting_approval` 到期 | 先還原,寫 `fault.lease_expired`;`expired_before_approval`;之後的窗口標 `safety_recovery: true`,**不計**成功 | `unresolved` |
| lease 在 `executing` 前到期 | 同上,`expired_before_execution` | `unresolved` |
| 到期還原失敗 | `safety_restore_failed` | `unresolved` |
| 操作者按中止 | 取消模型迴圈或執行、restore-all、寫 `operator.aborted`;`aborted_by_operator` | `unresolved` |
| 稽核前三項有 failed | `audit_rejected` | `unresolved` |
| 執行步驟失敗 | `action_failed` | `unresolved` |
| 預算用完不交報告 | `budget_exhausted` | `unresolved` |
| 模型離線、連續失敗、`inconclusive` | `unresolved` | `unresolved` |
| 對得到根因但 manifest 沒有動作 | `no_remediation_path` | `unresolved` |

`counted_recovery_success` 只有 `recovered` 與 `recovered_mitigated` 且非 `safety_recovery` 才是 true。結案時 `card_id` 填進 read model、偵測關閉、readiness 的 `next_step_zh` 變「已結案,按『開始下一輪』」。`durations`(偵測到提案、提案到批准、批准到結案)放在 report,不在 read model。

### 5.4 報告的幾個欄位怎麼算

- `measured.deviations`:釘住集合上每節點每軸的 `dev`。
- `truth`:實例 `applied_at` 換成 `t_injected` + 主要旋鈕的曲線 24 點 + `cards.yaml` 的 `root` `mechanism_family` `expected_action` `expected_order` `decoys`。調查中的 timeline **沒有** `truth` 欄位,結案後才有;report 結案前 409 `invalid_request`。
- `comparison`:AI 的 onset 與量測 onset 的秒差、AI 的順序與 `expected_order` 一不一致、根因對不對、動作對不對,四個值。
- `early_sign`:釘住集合裡第一張「root 的 saturation 或 latency 帶外、但 errors 還在帶內」的快照(給報告頁講「其實更早就看得出來」)。
- `timeline.system[]`:journal 事件逐筆映射(`kind` `label_zh` `seq` `t`;工具事件 `kind: "tool"` 帶 `tool` `node`);`ai` 用 `audit.timeline_status`(rejected 附 `reasons[]`)。

## 6. 對話模式(有空才做)

**目前沒有實作**:control 的路由裡沒有這條,打了回 404;console-v2 已經把「對話」分頁拿掉。以下是原本的設計,要做的時候照這份做。

`POST /api/chat/messages {"text"}`:同一組工具、同靜態前綴(另一個 `prompt_cache_key`),開場帶一次節點表;`t = 0` 是提問時刻;history 視窗夾到環形的 15 分鐘;預算 **8 次呼叫 / 120 秒**;事故在 `detected` 到 `verifying` 之間 → 409 `incident_active`;同時只有一個對話 → 409 `chat_busy`;回 `{"reply_zh","tool_calls":[{tool,args,summary_zh,duration_ms}]}`(有串流時改用 `API.md` §3 的 `chat` 事件)。

## 7. 加分規則

- **環形落地**:每 60 秒把環形原子寫到 `NIGHTWATCH_STATE_DIR/state/ring.json`;啟動時讀回;最後一張與現在差 > 10 秒 → 下一張快照帶 `gap_before: {from, to}`,journal 寫 `graph.gap`。
- **Grafana 第二偵測來源**:`POST /internal/alerts/grafana` 收 Grafana webhook;`alertname` 以 `Datasource` 開頭的忽略;事故未開 → 以 `detection.source = grafana` 開事故;已開 → 寫 `detection.corroborated`。
