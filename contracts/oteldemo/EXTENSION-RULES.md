# 整合層擴充規則

這份規則讓新增服務或訊號時只增加接線，不另造一套 NightWatch 真相。

## Source of truth

- node、edge、selector、check、runtime target、action 只加在 [`../manifest.yaml`](../manifest.yaml)。
- upstream flag 對應與 health target 只加在 [`../adapter.yaml`](../adapter.yaml)。
- card id、curve、truth、expected outcome 只加在 [`../cards.yaml`](../cards.yaml)。
- REST/SSE 形狀只加在 [`../schemas/`](../schemas/) 和 [`../API.md`](../API.md)。
- PromQL 名稱與 label 只加在 [`../METRICS.md`](../METRICS.md) 及 control 的集中常數。

本目錄的文字只解釋邊界與方法。不可複製完整 nodes、edges、flags 或 cards，
也不可把範例清單當成新的設定檔。

## 設計規則

1. 禁止依 node id 硬編服務行為；用 manifest `kind`、`selector`、`health_url`、
   `owner` 與 declared edge 驅動。id 只用來查資料和顯示。
2. upstream 負責業務協定、OTLP instrumentation 與 flag 消費；不要把控制碼
   塞回 upstream image。
3. adapter 負責 target discovery、health probe、flag 更新與 revision telemetry；
   不負責 graph、incident、Agent 或故障卡。
4. control 負責 snapshot、baseline、detection、proposal、approval、verification；
   只能使用 manifest 宣告的 action/runtime target。
5. Agent 只能從 capabilities 宣告的唯讀工具取證；不能從文字猜 hidden flag
   或直接呼叫 upstream mutation。

## 固定 extension review format

每一個 extension 都要用下面六個欄位寫 review；欄位不可省略。

### OTel service/node/edge

- 目前能力：manifest projection 支援 `service`、`synthetic`、`datastore`、`queue`。
- 可擴充內容：新增 node、dependency edge、layout、owner 或 selector；目前 OTel reference 是 19 nodes/24 edges。
- machine contract 改哪裡：`manifest.yaml`、manifest/node/edge schemas（若形狀改變）。
- 程式接點：control `sampling.go` 的 kind switch、graph projection、capabilities。
- 驗證：graph node/edge、trace/service graph、`check-live.ts` exact IDs。
- 風險：宣告 edge 可能暫時沒有 telemetry；不可把 `observed=false` 當不存在。

### Protocol/port 與 resource/span selector

- 目前能力：compose env/ports 和 collector span dimensions 提供接線資料。
- 可擴充內容：HTTP、gRPC、DB、queue operation，以及 resource/span attribute。
- machine contract 改哪裡：compose、`manifest.selector`、`METRICS.md`；不要複製到文件設定。
- 程式接點：collector receiver/connector、control selector query、dependency inventory。
- 驗證：抓一筆 Jaeger trace、Prometheus label、端口 health probe。
- 風險：同一 upstream 的 label 可能只有 `server.address`，不可猜 `db.system.name`。

### Metric axis/template

- 目前能力：snapshot 五軸與 capabilities 的五個 `node.*` template。
- 可擴充內容：新 metric、axis、extras 或 kind-specific query。
- machine contract 改哪裡：`METRICS.md`、schema（若 response 形狀改變）、manifest selector。
- 程式接點：control `sampling.go` 集中 PromQL 常數、node builder、agent query tool。
- 驗證：Prometheus query 有值、baseline/current 都可解釋、null 語意正確。
- 風險：OTel counter/gauge 型別與 label cardinality 不同；空值不可轉成零。

### Health probe

- 目前能力：adapter 依 target 宣告 `http|tcp|none` 探測；Agent 的 `run_health_check` 直接 GET manifest `checks[]` URL。
- 可擴充內容：新 upstream path、TCP port、timeout 或無 probe 節點。
- machine contract 改哪裡：`manifest.health_url`、`adapter.yaml.targets.health`。
- 程式接點：demo-adapter health handler、control check runner/readiness/node liveness。
- 驗證：healthy、connection refused、HTTP 5xx、`none` 四種案例。
- 風險：成功 HTTP 4xx 代表可達；不能用 adapter process health 代替 target health。

### Flag/knob/type

- 目前能力：adapter implementation 支援 number/string/boolean；現行 adapter.yaml 只宣告 number/boolean，並有 flagd OFREP、完整 config PUT。啟動預設 ResetAll/pristine/v1，`ADAPTER_KEEP_FLAGS=1` 才 SyncFromFile。
- 可擴充內容：新 flag、type、範圍、pristine value 或 flag mapping。
- machine contract 改哪裡：`adapter.yaml`、manifest `runtime_targets`、schema/API（若錯誤形狀改變）；min/max 由 control `ValidateKnobValue` 執行。
- 程式接點：adapter coercion/flagfile、control runtime inspect/pristine。
- 驗證：GET/PUT、null/錯型別、連續更新、OFREP 與 revision；min/max 由 control manifest 驗證，不由 adapter 驗證。
- 風險：flagd current value 沒有 revision；revision 是 opaque 且可不單調；回滾要送完整 known-good knobs。

### Runtime action

- 目前能力：manifest action 以 target、family、`put_config` step 驅動，需 approval。
- 可擴充內容：新 action、maintenance step、重試與 verification predicate；maintenance path whitelist 由 adapter.yaml 提供。
- machine contract 改哪裡：manifest `actions`/runtime targets、AGENT/API schemas。
- 程式接點：control audit、proposal builder、runtime executor、verification windows。
- 驗證：未批准不 mutation、每步結果可追溯、失敗/重試/成功 outcome。
- 風險：action target 與 truth root 可能不同；必須有 owner mapping 和 audit evidence。

### Fault curve/card（現場決定）

- 目前能力：cards schema 支援公開曲線預覽與 control 注入，卡內容由父層管理。
- 可擴充內容：新 generic curve、knob 組合、truth、decoy、expected outcome。
- machine contract 改哪裡：只改 `cards.yaml`、cards schema/examples、SHOP-INTERNAL 對應段落。
- 程式接點：control curve engine、fault admission、adapter PUT；不要在 adapter 寫 card id。
- 驗證：公開 catalog 不洩漏 truth/knobs、曲線作用、restore、完整 live cycle。
- 風險：一張卡未驗證不能推論其他卡；現場卡片內容與通用 adapter 必須分離。

### Agent tool/context

- 目前能力：8 個唯讀工具、20 calls、900 秒 timeout、proposal/approval gate。
- 可擴充內容：新 evidence source 或工具，但需保持 static capability prefix。
- machine contract 改哪裡：AGENT/API、capabilities schema、必要的 report/timeline schema。
- 程式接點：control `makeCapabilities`、agent tool dispatch、prompt/context builder、audit。
- 驗證：tool input/output、evidence id、budget、空值處理與 proposal gate。
- 風險：把 hidden data 放進 context 會破壞卡片公平性；空結果不能當健康證據。

### Log source / error-log bridge

- 目前能力：OTLP logs → control logstore → `search_logs`；Guard Room 尚未接。
- 可擴充內容：新 log source、monitor/v1alpha2 bridge、event dedupe、retention；Guard Room client、error tools、edge sync、audit 已存在。
- machine contract 改哪裡：METRICS/ERROR-LOG、monitor schema、Agent evidence/audit schema；啟用主要改 compose URL/collector pipeline。
- 程式接點：collector processors/exporter、control log ingest、既有 Guard Room client/tools；不要先改 official service/adapter/control。
- 驗證：severity/filter、trace correlation、event identity、重試和端到端 evidence。
- 風險：沒有 log 不等於健康；不得把精簡 OTLP row 偽裝成完整 monitor event。

## 新增東西的最小步驟

| 要新增 | 先改 | 再改 | 驗證 |
| --- | --- | --- | --- |
| service | manifest node/edges | compose、adapter target、health | graph ID、health、trace、metric |
| signal | METRICS source/query | control kind 分支或集中常數 | Prometheus query 與 snapshot |
| knob | adapter target knob | manifest runtime target | GET/PUT、OFREP、revision |
| action | manifest action | control execution mapping | proposal audit、approved PUT |
| error-log bridge | log/monitor source | Agent evidence/audit | event identity、time window、dedupe |

新增 service 時先建立 dependency inventory，再補 resource attributes、span
attributes、health 與 owner。新增 datastore/queue 用 selector；不要把
`postgresql`、`redis`、`kafka` 等實際名稱寫進通用 kind 分支。

## 驗證層級

1. 靜態：YAML/schema、`bun contracts/check.ts`、`git diff --check`。
2. 元件：adapter `go test ./...`、health/PUT/OFREP、collector config parse。
3. 接線：compose healthy/running、OTLP 到 Prometheus/Jaeger/logstore、graph nodes。
4. 流程：故障注入、R1–R3 detection、Agent evidence、proposal/approval、兩窗 recovery。
5. 現場：只把實測結果寫入 status/doc；未跑的 service/card 必須標未驗證。

一層失敗就不要用下一層的畫面結果掩蓋。新增契約後要同步 `check-live.ts`、
schema 或 examples 的必要變更，但不可為了過測試而放寬未知欄位與 hidden data。
