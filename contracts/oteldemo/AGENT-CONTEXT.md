# Agent Context 與工具邊界

本文件說明 control 交給模型的資料。實際程序、JSON report 與稽核規則以
[`../AGENT.md`](../AGENT.md) 為準；這裡只補官方 OTel Demo 的資料從哪裡來。

## Static prefix 與開場 context

每次 investigation 的 cacheable static prefix 實測約 6,229 字元、約 1,557 tokens。
它只從 manifest 組出 node id/kind、24 條 declared edges、5 個 runtime target 的
description/known-good revision/knob schema/maintenance；health check IDs 由
tool schema 提供。selector、health URL、host、path 和 command 不放入 static
prefix，也不當成 node description。

開場動態 JSON 只有 `detection`、`pinned_window` 和等距抽樣最多 12 張
`snapshots`，外加抽樣說明。它不預先放入 run、readiness、fault instance、
graph_now 或 capabilities；需要時由工具取回。Agent 仍受 report schema、
evidence id 和 manifest node id 限制。

重試開場才附最多兩筆 `repair_attempts`、`previous_attempt_result_zh`/reason、最多 40
筆 prior evidence，以及 pinned window 最新 6 張 snapshots。prior evidence
必須是上一輪有效工具結果，不能把整個歷史塞回 context。

Agent 能知道：

- 19 個 manifest 節點、24 條宣告邊與 node kind；node detail 的 edges_in/out 目前是空陣列。
- detection、pinned window、工具回傳的 snapshots、evidence 與 report 規則。
- 5 個 runtime target 的 description、known-good、knob schema、maintenance；
  只有 `inspect_runtime` 才讀到 current config。
- health check IDs；`run_health_check` 在 server 端直接執行 manifest checks[] URL，URL 不暴露給模型。

Agent 看不到：

- 官方服務內部記憶體、原始 flag implementation 或未輸出的 debug state。
- Prometheus 任意 metric；`query_metric` 只能選 5 個 template，且
  `node.self_error_rate` 目前回 `unsupported`。
- collector 丟棄的 flagd/feature-flag 題面 log，或未送到 collector 的 log。
- `search_logs` 的原始 rows、trace id；它只得到 aggregate patterns。
- Guard Room event；本 OTel compose disabled，雖然 control client、edge sync、
  audit 與兩個 error tools 已存在。

## Limits、output caps 與 report gate

目前有 8 個 tools、最多 20 次呼叫、hard timeout 900 秒，累計 input+output
上限 400,000 tokens；每次模型 output 上限 4,096 tokens。各 tool 傳給模型的
JSON byte cap 是：`inspect_runtime` 6,144、`get_node_history` 3,072、
`get_node_detail`/`run_health_check` 2,048、`find_traces`/`search_logs` 4,096、
`get_trace` 8,192、`query_metric` 1,024；Guard Room disabled 時另外兩個 caps
不會出現在 capabilities。

`search_logs` 最多讀 200 筆 raw records 後聚合成
`{total,patterns:[{sample,count,first_t,last_t,severity}]}`，不向模型暴露 trace
id。`run_health_check` 是 manifest check URL 的直接 GET，不是 adapter probe。
runtime repair 必須先形成 proposal，再等待人批准；批准後 control 執行並跑
兩個 20 秒驗證窗。報告前必須有成功的 `get_node_history`，以及 trace id 由先前
成功的 `find_traces` 授權的 `get_trace`；不能自造 trace id 或 evidence id。
最終只交一行符合 report schema 的 JSON；root、timeline、contributing、
ruled_out、confidence 與 cited evidence 必須使用實際工具結果。工具進度可簡短
說明目前查什麼，reportOnly 回合不可再呼叫工具；只有完全沒有可用訊號才回
`inconclusive`。

## 八個工具與來源

| 工具 | 主要資料源 | 看什麼 |
| --- | --- | --- |
| `inspect_runtime` | demo-adapter GET config | current config、known-good、knobs、maintenance |
| `get_node_history` | control ring snapshots | node 時間序列、baseline band、相對時間 |
| `get_node_detail` | manifest + current graph | node 軸、status、revision、check；in/out edges 空 |
| `find_traces` | Jaeger API | service 的 error/slow/any trace 摘要與可授權 trace IDs |
| `get_trace` | Jaeger API + manifest graph | 一筆 trace 的服務路徑、錯誤與慢服務 |
| `search_logs` | control logstore | OTLP log aggregate；model 不拿 raw row/trace id |
| `query_metric` | Prometheus API | 5 個 template；self_error_rate 為 unsupported |
| `run_health_check` | manifest checks[] URL | 宣告 check 的直接 HTTP 結果 |

## OTel 對接方式

service 的 request/error/latency 由 collector 的 `span_metrics` 轉成 Prometheus
series；service graph 只提供邊的觀測。synthetic `load-generator` 使用 k6
checkout API series；datastore 使用 client span selector 與 receiver；queue
使用 producer span 和 Kafka metrics。trace 詳情永遠回 Jaeger，log 詳情永遠回
control logstore。完整 PromQL 以 [`../METRICS.md`](../METRICS.md) 為準。

## 程序順序

先用 history/detail 找偏離的 node 與時間，再用 traces 找 propagation，最後用
logs 和 runtime inspect 找專屬訊號及可修復設定。工具結果需引用 evidence id；
報告的 root、timeline、repair_plan 不能超過宣告圖與 manifest 能力。若資料為
空，空本身不是健康證據，應換來源或交代不確定性。

## Context 形狀與時間語意

開場只給 detection、pinned window 和 snapshots；其他 state 由工具結果逐步補足。
graph node 的 id/kind/status、axis 值、health、revision 和 evidence reference
來自 control projection；incident 的 phase/outcome/detection 來自 control state
machine。Agent 不應從自然語言描述反推出未列出的 node、edge 或 action。

每個 evidence 要能指出 source、時間或 pinned window、查詢參數與結果摘要。
Prometheus 數值是 observation time，Jaeger span 有自己的 start/end，OTLP log
有 record time；三者不可因 UI 顯示同一個相對時間就當作同一事件。若 projection
延遲或欄位為 null，報告需保留該限制。

## Tool 使用界線

`get_node_detail` 和 `get_node_history` 適合找異常軸；`query_metric` 只能使用
capabilities 的 template；`find_traces`、`get_trace` 和 `search_logs` 用於
根因交叉證據；`run_health_check` 只回答宣告 probe。`inspect_runtime` 可讀目前
runtime config，但不會替代 approval。

Agent 可提出 exact target、knob、value 與 restore command；只有 control 在人
批准後才執行 mutation。任何工具 timeout、空結果、unknown service 或缺 log 都
要在 evidence 中標注，不能用 retry 次數換成信心分數。

## OTel 取值對照

| context 欄位 | OTel/整合來源 | 缺失時 |
| --- | --- | --- |
| node traffic/errors/p95 | collector span metrics → Prometheus | axis `null` |
| edge observed | service graph spans → Prometheus | `false`/unknown 依 schema |
| trace path | Jaeger OTLP projection | 交代 sampling/查詢窗 |
| log evidence | collector logs → control logstore | 不判健康 |
| runtime revision | adapter telemetry + config GET | 不能猜版本 |

上下文只代表本輪允許的 view；官方服務未輸出的 internal state、collector 被
filter 的 flagd 題面、Guard Room 未接的 event、pinned window 外歷史都不可見。
