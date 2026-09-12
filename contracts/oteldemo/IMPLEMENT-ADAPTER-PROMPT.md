# Generic Adapter 實作者 Prompt

以下內容可直接交給一位實作者。目標是實作通用 demo-adapter；官方 OTel Demo
服務、故障卡與 control 的偵測/Agent 流程都不在本任務範圍。

```text
你要在 NightWatch repo 實作 generic runtime adapter，讓現有 control 可以
透過 HTTP 讀取/更新官方 OpenTelemetry Demo 3.0.0 的 flagd runtime flags。

先讀這些輸入文件：
1. hackathon/contracts/adapter.yaml
2. hackathon/contracts/manifest.yaml 的 runtime_targets/actions
3. hackathon/contracts/SHOP-INTERNAL.md 的 PUT config 語意
4. hackathon/contracts/METRICS.md 的 revision metric/log 要求
5. hackathon/oteldemo/compose.yaml 與 hackathon/oteldemo/flagd/demo.flagd.json
6. hackathon/contracts/oteldemo/ADAPTER-CONTRACT.md
7. hackathon/contracts/oteldemo/EXTENSION-RULES.md
8. hackathon/contracts/oteldemo/DAY-OF-WIRING.md

範圍只有 hackathon/demo-adapter/：
- 讀 adapter.yaml，驗證 target、health kind/address、number/string/boolean knobs。
- 提供 GET /health、GET /targets、GET /{target}/healthz、GET /{target}/readyz。
- 提供 GET/PUT /{target}/internal/config；JSON null、未知 knob、型別錯誤與過大
  body 要回清楚的 4xx。未知 top-level 欄位可忽略，缺 revision 要保留目前值；
  min/max 越界由 control 的 manifest ValidateKnobValue 處理，不由 adapter 處理。
- PUT 要保留未指定 knobs、接受 opaque revision、把 flagd 檔案原地覆寫，避免連續
  曲線更新時 watcher 掉事件；啟動預設 ResetAll/pristine/v1，只有
  `ADAPTER_KEEP_FLAGS=1` 才從目前 flags 同步 knobs。
- 可選 telemetry sink 只輸出 `shop_config_revision{job="shop/<target>",revision="..."}=1`
  與 revision 改變時的 config-applied log（knob-only 同 revision 不送），
  由現有 OTLP pipeline 接走；不要在 adapter 自己實作 traces/metrics。
- health HTTP 只把連線錯誤或 5xx 算不健康；tcp 用有 timeout 的 dial；none 不探測。

明確不要做：
- 不改官方 OTel Demo image、服務程式、compose 的 upstream service 行為。
- 不修改 hackathon/contracts/cards.yaml，也不要把故障卡 id/curve 寫死在 adapter。
- 不實作 control 的偵測、Agent、approval、verification 或 console。
- 不把 flagd OFREP 當成 adapter 自己的 API；adapter 只寫 flag 檔並可供 control
  驗證，flagd 仍是 upstream dependency。

驗收命令：
（以下命令都以 repository root 為目前工作目錄。）
  (cd hackathon/demo-adapter && go test ./... && go vet ./...)
  (cd hackathon/contracts && bun check.ts)
  (cd hackathon/oteldemo && bash doctor.sh)
  (cd hackathon/contracts && bun check-live.ts http://127.0.0.1:3000)

手動驗收至少確認：
- GET /health 是 {"status":"ok"}。
- GET /targets 含所有 adapter.yaml targets。
- GET /targets 與 GET /{target}/internal/config 回傳 revision、knobs、applied_at，
  不宣稱含 manifest；config response 不需 target 欄位。
- PUT payment revision v2/paymentFailure 0.5 後，GET config、flagd OFREP、
  shop_config_revision 都反映新值。
- 連續多次 PUT 不會遺漏最後旗標值；PUT v1 與完整 known-good knobs 可回復。
- unknown target/knob、null、錯型別、control 越界和 upstream 不健康都有預期錯誤。
報告只列 adapter 目錄的檔案、測試輸出與限制；不要順手修其他 package。
```

Prompt 內的路徑是輸入與驗收入口，不是要新增的第二份契約。若實作遇到
manifest/cards 的語意衝突，停在 adapter 邊界並回報；不要自行改卡片或 upstream。

## 交付時一併回報

實作者要依 [`EXTENSION-RULES.md`](EXTENSION-RULES.md) 的固定格式說明任何新
接點，並依 [`DAY-OF-WIRING.md`](DAY-OF-WIRING.md) 交付 dependency inventory：
每列至少有 from/to、protocol/port、operation、resource/span attrs、health 與
runtime owner。程式應按 `kind`、selector、manifest 和 adapter 設定驅動；不要依
node id 寫分支，也不要把當日卡片內容或曲線常數放入 generic adapter。

若驗收只涵蓋部分 targets，列出已測和未測項目、實測時間、upstream 依賴與失敗
語意。文件、測試輸出和 inventory 都只引用 source-of-truth 的路徑，不複製一份
flags、nodes 或 edges 清單。

## 實作者不得擴張的邊界

- 不新增通用 framework、plugin registry 或與 OTel SDK 重疊的 abstraction。
- 不改 control 的 graph、incident、Agent、approval、card 或 console code。
- 不將 upstream health、flagd evaluation、telemetry ingest 混成一個 endpoint。
- 不在錯誤時回傳模擬成功 config、零值或健康狀態。
- 不將缺少 metric、trace、log 或 health 的服務當成 healthy。

## 最小回報格式

```text
changed files: <hackathon/demo-adapter files only>
tests: <commands and pass/fail>
inventory: <path or inline table following DAY-OF-WIRING>
source contracts read: <manifest/adapter/SHOP-INTERNAL/METRICS>
unverified: <targets, restart/readback or upstream cases not run>
```

若發現 source contract 本身需要改動，停止在 adapter 目錄內自行修正，回報檔案、
欄位和重現命令，交由契約 owner 決定。這能讓 one-shot 實作仍保持可審查，且讓
之後新增 service 或 knob 走同一套 manifest、schema、inventory 和驗收路徑。
