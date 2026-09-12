# OTel Demo 整合契約

這個目錄是官方 OpenTelemetry Demo 3.0.0 接入 NightWatch 的短索引。它描述
整合層的邊界與資料流，避免把現有契約再抄一份。可執行的真相仍在父層：

| 真相 | 用途 |
| --- | --- |
| [`../manifest.yaml`](../manifest.yaml) | 19 個圖節點、24 條宣告邊、checks、runtime targets、actions |
| [`../adapter.yaml`](../adapter.yaml) | demo-adapter 目標、health 探測與可調旋鈕 |
| [`../cards.yaml`](../cards.yaml) | 故障卡與曲線；現場卡片驗證狀態不由本目錄推論 |
| [`../schemas/`](../schemas/) | REST、state、graph、fault catalog 的 machine-readable 形狀 |
| [`../../oteldemo/compose.yaml`](../../oteldemo/compose.yaml) | 容器、埠、環境變數、依賴與資源限制 |
| [`../../oteldemo/otel/collector.yaml`](../../oteldemo/otel/collector.yaml) | OTLP receiver、connector、processor、exporter |

## 建議閱讀順序

1. [`UPSTREAM-INTERFACES.md`](UPSTREAM-INTERFACES.md)：官方 demo 實際提供什麼。
2. [`DATA-FLOW.md`](DATA-FLOW.md)：三條 telemetry/control/log 流如何接起來。
3. [`ADAPTER-CONTRACT.md`](ADAPTER-CONTRACT.md)：NightWatch 自訂 adapter 的邊界。
4. [`AGENT-CONTEXT.md`](AGENT-CONTEXT.md)：模型每輪看見的資料與限制。
5. [`ERROR-LOG.md`](ERROR-LOG.md)：目前 log 能力與 Guard Room 的未接部分。
6. [`EXTENSION-RULES.md`](EXTENSION-RULES.md)：未來加服務、訊號或 bridge 的規則。
7. [`DAY-OF-WIRING.md`](DAY-OF-WIRING.md)：比賽當天的 inventory、接線與驗收表。
8. [`IMPLEMENT-ADAPTER-PROMPT.md`](IMPLEMENT-ADAPTER-PROMPT.md)：generic adapter 實作 brief。

## 現況

官方服務透過 collector 送 OTLP traces、metrics、logs。control 讀 Prometheus
與 Jaeger 的查詢結果，並從 collector 收到一份精簡 logstore。demo-adapter
負責把 NightWatch 的通用 runtime config 翻成 flagd 檔案更新；它不是 OTel
telemetry adapter，也不替官方服務產生 traces 或 metrics。

現行 compose 的核心整合邊界是：frontend-proxy 對外 `:18080`、control
對外 `:3000`、collector OTLP gRPC `:4317`/HTTP `:4318`、Prometheus
`:9090`、Jaeger UI `:16686`、flagd OFREP `:8016`。容器內 hostname 與
主機映射以 [`../../oteldemo/README.md`](../../oteldemo/README.md) 為準。

目前已完成一次 `payment_failure_ramp` 真實流程，但四張其他卡尚未由此文件
宣稱通過。完整 live 證據與日期記在 [`../../docs/oteldemo-swap-spec.md`](../../docs/oteldemo-swap-spec.md)
§10；卡片本身仍只看 [`../cards.yaml`](../cards.yaml)。

## 邊界速查

| 問題 | 看哪裡 |
| --- | --- |
| 圖上節點或 edge 應該叫什麼 | `manifest.yaml` |
| 服務要用哪個 health URL | `manifest.yaml` 的 `health_url`、adapter `targets` |
| 哪個 flag 可被 runtime target 改 | `manifest.yaml` 的 `runtime_targets`、`adapter.yaml` |
| PromQL 與指標 label | [`../METRICS.md`](../METRICS.md) |
| REST/SSE、incident、approval | [`../API.md`](../API.md) |
| 通用 runtime PUT 語意 | [`../SHOP-INTERNAL.md`](../SHOP-INTERNAL.md) |
| Agent prompt、工具程序與稽核 | [`../AGENT.md`](../AGENT.md) |
| 起 stack、起 console、doctor | [`../../oteldemo/README.md`](../../oteldemo/README.md)、[`../../../RUNBOOK.md`](../../../RUNBOOK.md) |

若 source of truth 與本目錄文字不同，以 machine-readable 檔和現行程式為準，
再修正這份說明；不要在本目錄新增第二份 nodes、flags 或 cards 清單。

## 按工作選入口

| 要做的事 | 先讀 | 接著讀 |
| --- | --- | --- |
| 核對 upstream 端口與協定 | `UPSTREAM-INTERFACES.md` | `DAY-OF-WIRING.md` |
| 查 telemetry 到哪裡 | `DATA-FLOW.md` | `../METRICS.md`、`ERROR-LOG.md` |
| 實作 runtime adapter | `ADAPTER-CONTRACT.md` | `IMPLEMENT-ADAPTER-PROMPT.md` |
| 設計 Agent 輸入 | `AGENT-CONTEXT.md` | `../AGENT.md`、`../API.md` |
| 增加服務或訊號 | `EXTENSION-RULES.md` | source-of-truth 檔與 wiring 表 |
| 比賽日排障 | `DAY-OF-WIRING.md` | `../../oteldemo/README.md`、`RUNBOOK.md` |

## 目前邊界與證據

本目錄文件是人工導覽，檔案中的數字只用來指出目前版本的規模。實際 node、
edge、flag、selector、action、schema 與 compose dependency 要從連結的來源讀取。
若新增內容需要複製一份清單，先考慮是否應該改 source-of-truth 或增加 selector。

已驗證的 live 範圍只涵蓋一個 payment failure ramp 流程與其修復窗口；其他
故障卡、完整 Guard Room error event 與所有宣告 edge 不因有這份導覽就算驗證。
提交文件時應附 `check-live.ts`、adapter tests 或實際 trace/log 的證據路徑，並
標出使用的 commit/worktree 與時間。

## 快速檢查

```sh
cd hackathon/contracts
bun check.ts
bun check-live.ts http://127.0.0.1:3000
cd ../oteldemo
bash doctor.sh
```

這些命令只能證明各自的契約、live projection 或 upstream 接線；命令通過不會
替代 card-level fault evidence，也不會使未接的 Guard Room 變成可用。
