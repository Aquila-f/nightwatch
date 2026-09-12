# 契約變更紀錄(只有協調者寫;一行一件,新的在上)

| 時間 | 改了什麼 | 誰要重跑什麼 |
|---|---|---|
| 2026-09-11 | 被觀察系統換成官方 OTel Demo 3.0.0 + `demo-adapter`:`manifest.yaml` 加 node `selector` 與 check `node` 欄位,故障卡換成五張 flagd 劇本,新增 `adapter.yaml`,重寫 `SHOP-INTERNAL.md` 與 `METRICS.md` 的 adapter / k6 / Kafka / span-metrics 契約,`API.md` §2 改成 oteldemo ports 與 env | deploy / adapter / control / console 依 `docs/oteldemo-swap-spec.md` 重接;live 驗證 k6、Kafka lag、Redis selector 名稱 |
| 2026-09-11 | `API.md` §5 基線改成**落後的滑動窗**(24 張窗、最新 6 張不納入、有節點 failing 就整拍不收),不再是「收滿就凍結」 | 前端:無(readiness 文字不變);control:已實作(`45822af`) |
| 2026-09-11 | `API.md` §7 稽核五項 → **六項**(加 `error_log_cited`)、§8 工具七個 → **九個**(加 `list_errors`、`get_node_errors`,只在 `NIGHTWATCH_GUARDROOM_URL` 有設時出現);`AGENT.md` §1.1 靜態前綴改走 Responses 的 `instructions`、開場訊息抽樣上限 12 張、§1.4 程序門檻的實際行為、§2 兩個 Guard Room 工具的規則、§3 第六項與 `NIGHTWATCH_GUARDROOM_AUDIT_STRICT`、§6 對話模式標成未實作 | 前端:`audit.checks` 要動態列項、總體判定用後端的 `audit.status`;`report.schema.json` 的 `id` enum 要含 `error_log_cited` |
| 2026-09-11 | `SHOP-INTERNAL.md` §8 加 `SHOP_MONITOR_URL`(店面送 `monitor/v1alpha2` 事件到 Guard Room;空字串就不送) | 店面:無(已實作);deploy:`deploy/.env` 給值才會生效 |
| 2026-09-10 21:30 | `METRICS.md` §3 加兩條通則:除法分母 `clamp_min`、宣告邊怎麼算 observed(control 02 xhigh 提的) | control 02:無,已經這樣做 |
| 2026-09-10 21:00 | `API.md` §5:extras 查不到的鍵省略、不填 null(control 02 在來源掛掉時填 null,`check-live` 抓到) | control 02 改;`check-live` 不變 |
| 2026-09-10 20:30 | `API.md` §2、`SHOP-INTERNAL.md` §8 寫明 main 套件路徑與 build 指令(deploy 01 猜錯路徑);compose 的 profile 與 min 子集合的決定寫在 `deploy/BRIEF.md` | deploy 02 順手修 01 的命名 |
| 2026-09-10 20:20 | `capabilities.links` 固定三個鍵,加 `storefront`(console 02 提的) | control 01 補一個鍵;console 02 改成從 links 拿 |
| 2026-09-10 20:00 | 新增 `AGENT.md`(契約 4:排查迴圈、工具規則、五項稽核、動作解析、驗證謂詞與結局、對話模式、加分規則);`API.md` §1 載入驗證與 `curve_unit`、§3 `round_not_needed`、`graph?at` 404、`/api/debug/logs`、實例 PUT 連續 5 次失敗 → `unknown`、§5 就緒八項與 `next_step_zh` 文字、無資料節點、logstore 上限、§6 journal 全表與 `base_revision`、§7 §8 指到 AGENT.md | control 02 以後照新契約;`truth.decoys` cards.yaml 本來就有 |
| 2026-09-10 19:40 | 任務檔改成只定目標,細節搬進契約。`API.md`:§2 compose-min 主機埠、`NIGHTWATCH_SHOP_URLS`、模型金鑰來源;§3 `GET /api/incidents`、`/events`、chat 串流;§5 小折線;§6 phase/outcome/actor 中文與「正在查 X」;§9 history 由 snapshots 推。`SHOP-INTERNAL.md`:程序行為、錯誤 body、payment reason、空車 400、跳過出貨、工人數與佇列量測、稽核磁碟規則、`SHOP_SHOPPER_COUNT`、摘要 log。`cards.yaml` 加 `expect.expected_outcome`(schema 同步) | control 04 以後、console 02 以後、店面 02 以後照新契約;已合併的 01 不用重跑 |
| 2026-09-10 18:40 | `API.md` §2 加兩個開發用旗標 `NIGHTWATCH_BASELINE_AUTO` `NIGHTWATCH_ROUNDS_ALWAYS`;`SHOP-INTERNAL.md` §3 `step` 曲線總長公式;read model 沒有獨立 schema、`durations` 只在 report(任務 05、08 改字) | control:無(只是講清楚) |
| 2026-09-10 18:10 | `GET /api/faults/instances` 回整個 faults 物件 `{instances, generation}`(原本文件說陣列、schema 說物件,medium 模型的試跑抓到) | control 01 重跑 check-live;`check-live.ts` 改成對 faults schema 驗 |
| 2026-09-10 18:00 | SSE 心跳改成每 2 秒 `event: ping`(原本 15 秒 `: ping` 註解行);前端 stale 6 秒 | control 01 / console 01 重跑 check-live 與瀏覽器驗收 |
| 2026-09-10 17:40 | `SHOP-INTERNAL.md` §6 標成建議值;§8 `SHOP_CONFIG_PRISTINE` 格式講清楚 | 店面:無 |
| 2026-09-10 17:00 | `API.md` `capabilities.tools` 形狀;`/api/graph` 列入 01;範例曲線數字標示意 | control 01 |
