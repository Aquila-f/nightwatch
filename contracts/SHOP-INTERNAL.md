# 契約 2:店面內部端點與旋鈕(control → 店面)

官方 OpenTelemetry Demo 不知道 control 存在。control 仍使用原本的內部端點契約;現在由 `hackathon/demo-adapter` 實作,把 runtime config 翻成 flagd 旗標,並代替各服務做健康探測。

## 1. 每個店面服務都有的端點

`NIGHTWATCH_SHOP_URL_TEMPLATE=http://demo-adapter:8080/%s`,所以 target `payment` 的 base URL 是 `http://demo-adapter:8080/payment`。

| 端點 | 行為 |
|---|---|
| `GET http://demo-adapter:8080/<target>/healthz` | 依 `hackathon/contracts/adapter.yaml` 的 target health 設定探測;健康回 200,不健康回 503 |
| `GET http://demo-adapter:8080/<target>/readyz` | 形狀與探測行為同 `healthz` |
| `GET http://demo-adapter:8080/<target>/internal/config` | `{"revision":"v1","knobs":{...},"applied_at":"2026-...Z"}` |
| `PUT http://demo-adapter:8080/<target>/internal/config` | body `{"revision":"v2","knobs":{...}}`。**合併不是取代**:只覆蓋 body 裡有的旋鈕,其他旋鈕保持原值。原子套用。冪等:內容跟現況一樣就回 200 但不做事、不寫 log。`revision` 有變才寫一行 INFO log `config applied revision=v2`。壞 JSON、未知旋鈕、型別不符或 `null` 回 400 |
| `POST http://demo-adapter:8080/<target><path>` | 執行 `http_post` maintenance;合法 `path` 與 reset / set 行為只由 `hackathon/contracts/adapter.yaml` 定義,未宣告路徑回 404 |

為什麼 PUT 是合併:control 的曲線引擎每 2 秒只重送這張卡自己的那幾顆旋鈕;如果是取代,會洗掉同 target 上別的修復設定。回滾到 v1 時 control 會送**完整的出廠旋鈕表**,所以合併語意下一樣會全部重設。

`revision` 改變後,adapter 替該 target 報 `shop.config.revision{revision="<revision>"}=1`(見 `METRICS.md`)。只有 knob 值變、revision 沒變時不寫 `config applied revision=...` log。

## 2. 旋鈕表(出廠值 = `v1`)

下表的官方行為以 [services-1](../docs/oteldemo-sweep/services-1.md) 與 [services-2](../docs/oteldemo-sweep/services-2.md) 的原始碼普查為準。

| target | knob | type | v1 | 官方 Demo 設定後的行為 |
|---|---|---|---|---|
| payment | `paymentFailure` | number,0–1 | 0 | 每筆 Charge 以 `Math.random() < value` 決定是否失敗;錯誤字串 `Payment request failed. Invalid token. demo.user_context.loyalty_level=gold`,span status error |
| cart | `cartFailure` | number,0–1 | 0 | **只影響 `EmptyCart`**,不影響 AddItem / GetCart。命中時改打 `badhost:1234`,最後回 `FailedPrecondition`,訊息前綴 `Can't access cart storage.`;checkout 仍可能完成訂單但會變很慢 |
| recommendation | `recommendationCacheFailure` | boolean | false | true 時 cache miss 路徑反覆追加商品 id,cache 與處理延遲成長。改回 false 只停止使用異常路徑,**不會釋放已成長的 global list**;要回收只能重啟服務 |
| checkout | `kafkaQueueProblems` | number(實際須為 integer) | 0 | checkout 每筆訂單除正常訊息外再送 N 份複本;fraud-detection 在 N > 0 時每則固定 sleep 1 秒。會製造 consumer lag;值以整數讀取,小數會退回預設 0 |
| email | `emailMemoryLeak` | number | 0 | 值 ≥ 1 時保留寄件並按倍數放大本文;值 **< 1 等同 off**。切回 < 1 後要再進一筆 email 請求才會 clear 已保留的 deliveries |

只有 `paymentFailure`、`cartFailure` 是「連續比例」且適合 linear / exp 曲線。`recommendationCacheFailure` 是布林開關,`kafkaQueueProblems` 是整數份數,`emailMemoryLeak` 是 ≥ 1 才有意義的放大倍數;後三者用 const / step。

## 3. 曲線(control 端的規則;adapter 只看到每 2 秒一次的 PUT)

故障卡(`cards.yaml`)定義「哪幾顆旋鈕、照什麼曲線變」:

| 曲線 | 參數 | 第 t 秒的值 |
|---|---|---|
| `const` | `value` | 永遠 `value` |
| `linear` | `from` `to` `duration_secs` | `from + (to − from) × min(t/duration, 1)` |
| `exp` | `from` `to` `duration_secs` | `from × (to/from)^(min(t/duration,1))`;`from` 為 0 時改成 `to × (e^(5·p) − 1)/(e^5 − 1)`,p = min(t/duration,1) |
| `step` | `levels[]` `hold_secs` | 每 `hold_secs` 跳到下一個 level,走完停在最後一個;總長 = `(len(levels) − 1) × hold_secs`(預覽用這個算) |

都可加 `noise_stddev`。曲線走完停在終值。control 每 2 秒算一次現值,**值有變才 PUT**(同一個 revision)。boolean 旋鈕只用 `const`。

五張卡動的旋鈕:

| 卡 | 動的旋鈕 | 修復動作 |
|---|---|---|
| `payment_failure_ramp` | payment `paymentFailure` exp 0→0.6/150s | `restore_payment_config:payment` |
| `recommendation_cache_growth` | recommendation `recommendationCacheFailure` const true | `restore_recommendation_config:recommendation`(停止異常路徑,不保證立即釋放既有記憶體) |
| `kafka_consumer_backlog` | checkout `kafkaQueueProblems` step [0,10,25,50,100],每階 30s | `restore_kafka_config:checkout` |
| `payment_failure_with_cart_decoy` | payment `paymentFailure` exp 0→0.45/120s + cart `cartFailure` const 0.03 | `restore_payment_config:payment` |
| `email_memory_growth` | email `emailMemoryLeak` step [0,10,100,1000],每階 45s | `restore_email_config:email` |

## 4. 修復動作的步驟(`manifest.yaml` 的 `actions[]`)

| step kind | control 做什麼 |
|---|---|
| `put_config` `{revision: v1}` | `PUT http://demo-adapter:8080/<target>/internal/config` body `{"revision":"v1","knobs":<該 target 完整出廠表>}` |
| `set_knob` `{knob, value}` | 先 `GET /<target>/internal/config` 讀現況,只改那一顆,`PUT` 回去(revision 不變) |
| `http_post` `{path}` | `POST http://demo-adapter:8080/<target><path>`;path 必須在 `hackathon/contracts/adapter.yaml` 該 target 的 `maintenance` 宣告 |

target 是 node id;主機開發期仍可用 `NIGHTWATCH_SHOP_URL_TEMPLATE` 改寫 base URL。

## 5. adapter 怎麼映射到 flagd

一顆 knob 對一顆 flag;預設 flag 名等於 knob 名,`adapter.yaml` 也可用 `flag:` 明確改名。PUT 時 adapter 讀 `demo.flagd.json`:

1. 值等於既有 variant 時,直接把 `defaultVariant` 指到該 variant(例如 0 → `off`)。
2. 沒有既有 variant 時,寫入 adapter 專用的 `nw` variant,再把 `defaultVariant` 指到 `nw`。
3. **原地覆寫**(truncate + 一次寫完 + fsync)同一個檔,inode 不變,flagd 的 file watcher 才跟得住連續改寫。

flagd 與 adapter 掛**同一個目錄**(`./flagd`)。寫法有兩種:`ADAPTER_WRITE_MODE=inplace`(預設)原地覆寫;`rename` 寫暫存檔再換名。實跑結果:rename 在單次改寫時 flagd 跟得到(PUT 0.37 → OFREP 0.37),但 control 曲線每 2 秒連續改寫時 flagd 的 watcher 會掉——檔案已經是 0.6、OFREP 還回 0,restart flagd 才讀到;inplace 連續 12 次每 1.5 秒一寫全部跟到。所以預設用 inplace,rename 只留作對照。

vendored `demo.flagd.json` 另補 `loadGeneratorFloodHomepage`（k6 會查;上游缺少會一直出 404）與 `loadGeneratorVUs`（預設 `10`）。

## 6. health probing

`adapter.yaml` 每個 target 的 `health.kind` 決定 `healthz` 與 `readyz`:

| kind | 行為 |
|---|---|
| `tcp` | 連 `addr` 的 host:port;連不上或 timeout 回 503 |
| `http` | GET 完整 `addr`;連不上、timeout 或 5xx 回 503,其餘 HTTP status 視為可達 |
| `none` | 沒有可探測端點的純 consumer;target 存在即回 200 |

探測位址與協定逐 target 宣告;不要從 node id 猜埠號。不存在的 target 回 404。

## 7. `contracts/adapter.yaml`

設定形狀:

```yaml
listen: ":8080"
flags_file: /data/demo.flagd.json
targets:
  payment:
    health: {kind: tcp, addr: payment:50051}
    knobs:
      paymentFailure: {flag: paymentFailure, type: number, pristine: 0}
  frontend-proxy:
    health: {kind: http, addr: http://frontend-proxy:8080/}
```

頂層是 `listen`、`flags_file`、`targets`。target 可有 `health`、`knobs`、`maintenance`;knob 欄位是 `flag`(可省略)、`type`(`number|string|boolean`)、`pristine`;maintenance key 是 `/internal/...` 路徑,值可用 `reset: true` 或 `set: {knob: value}`。本版沒有需要 `http_post` 的卡,所以實際檔案目前未宣告 maintenance path;日後若新增,只能以 [`hackathon/contracts/adapter.yaml`](adapter.yaml) 的宣告為準。

## 8. demo-adapter 環境變數與邊界

| 變數 | 意思 |
|---|---|
| `ADAPTER_CONFIG` | adapter 設定路徑;compose 用 `/etc/demo-adapter/adapter.yaml` |
| `ADAPTER_FLAGS_FILE` | 覆寫 flag 檔路徑;compose 用 `/data/demo.flagd.json` |
| `ADAPTER_LISTEN` | 覆寫監聽位址;預設 / compose 為 `:8080` |
| `ADAPTER_WRITE_MODE` | flag 檔寫法;預設 `inplace`(原地覆寫),`rename` 在連續改寫下 flagd 會跟丟,只留作對照 |
| `ADAPTER_KEEP_FLAGS=1` | 啟動時保留 flag 檔現值;未設時把 adapter 管理的 knobs 回到 pristine / v1 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | adapter 的 revision metric 與 config log 出口;compose 用 `http://otel-collector:4317` |

官方 Demo 的服務只知道 flagd 與自己的業務依賴,**不知道 control 存在**。control 只叫 demo-adapter;adapter 只改 flag 檔、探測服務並報 revision,不改官方服務 API。
