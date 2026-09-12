# demo-adapter 契約

demo-adapter 是 NightWatch 和官方 OTel Demo 之間的通用 runtime adapter。
它把宣告的 config request 轉成 flagd 更新、探測 upstream target、回報
revision；它不是 telemetry adapter，不接管 OTLP，也不修改官方服務程式。

## 設定來源

唯一的 adapter 配置是 [`../adapter.yaml`](../adapter.yaml)：

```yaml
listen: ":8080"
flags_file: /data/demo.flagd.json
targets:
  payment:
    health: {kind: tcp, addr: payment:50051}
    knobs:
      paymentFailure: {type: number, pristine: 0}
```

每個 target 可有 `health.kind` `http|tcp|none` 與 knobs。knob 的 flag 名稱
預設等於 knob 名稱；implementation 支援 `number`、`string`、`boolean` 三種
type，本目錄目前的 `adapter.yaml` 只使用 `number` 與 `boolean`。manifest 的
`runtime_targets` 才是 control 對外允許的語意、範圍與 known-good config。

## HTTP surface

| 方法/路徑 | 回應與用途 |
| --- | --- |
| `GET /health` | `{"status":"ok"}`；adapter process 活著 |
| `GET /targets` | 每個 target 的 `revision`、`knobs`、`applied_at`；不含 manifest 宣告資料 |
| `GET /{target}/healthz` | 依 target health 探測 upstream；連不上或 HTTP 5xx 回 503 |
| `GET /{target}/readyz` | 與 healthz 相同探測語意，供 control readiness 使用 |
| `GET /{target}/internal/config` | 回目前 `revision`、`knobs`、`applied_at`；response 不含 target 欄位 |
| `PUT /{target}/internal/config` | 合併 revision/knobs、檢查 JSON/type，成功後更新 flagd 檔案 |
| `POST /{target}/internal/{rest}` | 預留 maintenance；只有 manifest 宣告才由 control 使用 |

未知 target 是 404。JSON body 過大、格式錯誤、未知 knob、type 不符或 null
值會拒絕；不要把 null 靜默轉成零值。未知 top-level 欄位會被 adapter 忽略，
缺少 `revision` 則保留目前 revision；PUT 沒有 knobs 時只改 revision。adapter
只做 type/coercion，不做 min/max 越界驗證；範圍由 control 依 manifest
`ValidateKnobValue` 負責。有 knobs 時只更新指定值，其餘目前值保留。
空變更可回目前 config。

## Revision 與 flagd

成功 PUT 的 `revision` 是 opaque label，初始值和 ResetAll 都是 `v1`；它不保證
單調，也不是 flagd 的版本協定。adapter 以 flagfile store 原地覆寫旗標檔，避免連續曲線更新時
watcher 漏掉 rename 事件；flagd 會在下一次讀取看到新值。可用 upstream
OFREP `POST flagd:8016/ofrep/v1/evaluate/flags/<flag>` 驗證 flag 值，但 OFREP
不回 revision。

adapter 若有 telemetry sink，會送
`shop_config_revision{job="shop/<target>",revision="..."}=1`，沒有 `target`
label；只有 revision 改變才送一筆 `config applied` log，knob-only 且同 revision
不送。這些再經 collector 進 Prometheus/control。預設啟動執行 `ResetAll`，把
所有 knob 寫回 pristine、revision 設為 `v1`；只有 `ADAPTER_KEEP_FLAGS=1` 才
`SyncFromFile` 讀回檔案中的目前值，revision 仍回 `v1`。因此 control 回滾
必須送完整 known-good config。

## Health 規則

`http` target 只把連線錯誤與 status >= 500 視為不健康；任何成功的 2xx–4xx
回應都代表 upstream 可達。`tcp` 以 1.5 秒 context 嘗試連線。`none` 不探測，
適用 accounting/fraud-detection 這類沒有可用 target surface 的節點。

這些 health endpoint 是 NightWatch custom endpoint。官方服務的原生協定和
埠見 [`UPSTREAM-INTERFACES.md`](UPSTREAM-INTERFACES.md)，control REST 與
錯誤 envelope 見 [`../API.md`](../API.md)。

## 驗收

用 [`../../oteldemo/doctor.sh`](../../oteldemo/doctor.sh) 檢查 targets、
Prometheus labels、Jaeger 與 OFREP；再用 `check-live.ts` 驗 control projection。
故障卡的 id、curve 與 expected outcome 不在 adapter 契約內，仍由
[`../cards.yaml`](../cards.yaml) 管理。

## Request 範例與錯誤邊界

讀取目前值：

```http
GET /payment/internal/config
```

合併指定 knob：

```http
PUT /payment/internal/config
Content-Type: application/json

{"revision":"v2","knobs":{"paymentFailure":0.5}}
```

成功回應包含 revision、knobs 與 applied time，不含 target；control 以回應和後續
metrics/log 做 evidence。unknown target、unknown knob、null、JSON 型別錯誤、
body 超限都屬 adapter 的 client error；缺 revision 和未知 top-level 欄位可接受，
number 越界由 control manifest 驗證。upstream probe failure 屬 dependency error，
兩者不要共用成功狀態碼。

revision 是整合層的 opaque audit label，不是單調計數，也不是 flagd 的版本協定。實作者要保留未
指定欄位，並讓連續 PUT 的最後一次值可從 GET 與 OFREP 讀回。若寫檔或 watcher
失敗，回報錯誤且不要回傳已套用；重啟預設 ResetAll，只有
`ADAPTER_KEEP_FLAGS=1` 才以目前 flag 檔初始化 knobs，revision 回復規則以
`SHOP-INTERNAL.md` 和 control caller 為準。

## 執行前檢查表

- `adapter.yaml` target、health kind/address、knob type 皆可解析。
- flags file 存在且 JSON 可讀；未知 flag 不被 adapter 以猜測方式新增。
- HTTP health timeout、TCP dial timeout 和 `none` 語意符合本文件。
- revision 改變時能找到 config-applied log；knob-only 同 revision 不要求該 log。
- runtime action 由 control 使用 manifest 宣告的 target/action；adapter 的 maintenance
  path whitelist 來自 `adapter.yaml`，adapter 不解析 cards 或 manifest limits。
- 反覆 PUT、重啟、OFREP readback 與 upstream down case 都有可重現輸出。

若 upstream 只提供 gRPC，adapter 可做 TCP 可達性 probe，但不能由 TCP 成功
推斷業務 RPC 成功。若需要 RPC-level health，應在 adapter.yaml 宣告新的 health
kind 並同步實作、schema 與測試，不在 caller 內硬編 target 名稱。
