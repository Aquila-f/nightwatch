# Contracts 索引

本目錄保存 NightWatch 對接契約與 machine-readable schema。官方 OTel Demo
3.0.0 的整合文件集中在 [`oteldemo/README.md`](oteldemo/README.md)，從那裡
按 upstream interface、資料流、adapter、Agent、error log 和 wiring checklist
開始閱讀。

執行真相只有父層檔案：

- [`manifest.yaml`](manifest.yaml)：nodes、edges、checks、selectors、runtime targets、actions。
- [`adapter.yaml`](adapter.yaml)：demo-adapter targets、health 與 knobs。
- [`cards.yaml`](cards.yaml)：故障卡、曲線、truth 和 expected outcome。
- [`schemas/`](schemas/)：API、state、graph、incident、catalog 等 JSON schema。

一般 NightWatch API 看 [`API.md`](API.md)，PromQL/telemetry 看 [`METRICS.md`](METRICS.md)，
runtime PUT 看 [`SHOP-INTERNAL.md`](SHOP-INTERNAL.md)，Agent 流程看 [`AGENT.md`](AGENT.md)。
`oteldemo/` 文件只做解釋和操作順序，不複製上述清單，因此不會形成第二份真相。

若工作內容是官方 OTel Demo 的服務、telemetry、runtime adapter 或 Agent 接線，
先讀 [`oteldemo/README.md`](oteldemo/README.md)；其中的 `UPSTREAM-INTERFACES.md`、
`DATA-FLOW.md`、`ADAPTER-CONTRACT.md`、`AGENT-CONTEXT.md`、`ERROR-LOG.md`、
`EXTENSION-RULES.md` 與 `DAY-OF-WIRING.md` 分別對應接口、資料流、自訂 adapter、
模型上下文、錯誤事件、擴充規則與現場 inventory。實作 brief 見
[`oteldemo/IMPLEMENT-ADAPTER-PROMPT.md`](oteldemo/IMPLEMENT-ADAPTER-PROMPT.md)。
