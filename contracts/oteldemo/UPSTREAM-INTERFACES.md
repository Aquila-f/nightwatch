# 官方 OTel Demo 3.0.0 提供的接口

這份只記錄官方 demo 與整合層可觀察到的接口。NightWatch 自訂 REST、adapter
與 control 內部端點另列為 custom，不把它們假裝成 upstream API。

## Telemetry

| 接口 | 位址/協定 | 用途 | 性質 |
| --- | --- | --- | --- |
| OTLP traces/metrics/logs | `otel-collector:4317` gRPC、`:4318` HTTP/protobuf | 官方服務與 k6 輸出 telemetry | upstream 接入點 |
| Prometheus OTLP receiver | `prometheus:9090/api/v1/otlp` | collector 寫入 OTLP metrics | collector/整合配置 |
| Jaeger OTLP gRPC | `jaeger:4317` | collector 寫入 traces | collector/整合配置 |
| collector health | `otel-collector:13133/` | compose healthcheck | collector 接口 |

服務的 `service.namespace` 固定為 `shop`，`service.version` 為 `3.0.0`；
`service.name` 應與 manifest node id 相同。實際 receiver、connector 和 label
維度以 [`../../oteldemo/otel/collector.yaml`](../../oteldemo/otel/collector.yaml)
與 [`../METRICS.md`](../METRICS.md) 為準。

## flagd

官方服務在容器網路透過 flagd gRPC `flagd:8013` 讀旗標。OFREP HTTP 在
`flagd:8016`，整合測試可 POST `/ofrep/v1/evaluate/flags/<flag>`；這是
upstream flagd 協定，不是 adapter 的控制 API。

vendored [`../../oteldemo/flagd/demo.flagd.json`](../../oteldemo/flagd/demo.flagd.json)
目前提供這些旗標：

`adFailure`, `adHighCpu`, `adManualGc`, `cartFailure`, `emailMemoryLeak`,
`failedReadinessProbe`, `imageSlowLoad`, `intlShippingSlowdown`,
`kafkaQueueProblems`, `loadGeneratorFloodHomepage`, `loadGeneratorTraffic`,
`loadGeneratorVUs`, `paymentFailure`, `paymentUnreachable`,
`productCatalogFailure`, `recommendationCacheFailure`。

其中 `loadGeneratorVUs` 的 default variant 是 `30`；load-generator wrapper
會在下一次 poll 讀它並重啟 k6。這個 flag 檔是整合層掛入的配置，不能當作
官方服務的 HTTP runtime API。故障卡使用哪些旗標，仍只看 [`../cards.yaml`](../cards.yaml)。

## 官方服務協定與 health

下表是 compose 與 adapter target 使用的容器內協定；health 探測由 adapter
依 [`../adapter.yaml`](../adapter.yaml) 執行，並非假設每個 upstream 都有相同
的 HTTP `/healthz`。

| 服務/node | 協定與埠 | adapter 探測 |
| --- | --- | --- |
| frontend-proxy | HTTP `:8080` | GET `/` |
| frontend | HTTP `:8080` | TCP |
| product-catalog | gRPC `:3550` | TCP |
| cart | gRPC `:7070` | TCP |
| checkout | gRPC `:5050` | TCP |
| recommendation | gRPC `:9001` | TCP |
| ad | gRPC `:9555`、Prometheus `:9465` | TCP |
| currency | gRPC `:7001` | TCP |
| image-provider | HTTP `:8081/status` | GET |
| payment | gRPC `:50051` | TCP |
| shipping | gRPC `:50050` | TCP |
| email | gRPC `:6060` | TCP |
| quote | HTTP `:8090` | TCP |
| accounting | compose service | `none` |
| fraud-detection | compose service | `none` |

官方 compose 內的非業務依賴也提供整合可觀測的 network endpoint，但它們不是
可由 Agent 直接修復的 runtime target：

| 依賴 | 協定與埠 | compose health / 觀測 |
| --- | --- | --- |
| astronomy-db | PostgreSQL `:5432` | postgres healthcheck、DB receiver metrics |
| valkey-cart | Redis/Valkey `:6379` | `valkey-cli ping`、Redis receiver metrics |
| kafka | Kafka `:9092`；controller `:9093` | `nc -z kafka 9092`、Kafka metrics |

這些 port 是容器網路地址。它們的 client service、selector、graph kind 和
是否成為 manifest node，仍以 manifest 的 `datastore`/`queue` 宣告為準；不要
因為 compose 有一個 dependency 就在 control capabilities 自動增加 tool。

## Storefront

購物頁是官方 storefront，由容器內 `frontend-proxy:8080` 對外 published 到主機
`:18080` 提供（瀏覽器使用 `<LAN IP>:18080`）。主要
upstream route 包括 `/`、`/api/products`、`/api/recommendations`、
`/api/currency` 與 `/api/checkout`；精確 probe URL 與節點掛載位置以 manifest
`checks[]` 為準。NightWatch 的 console-v2 是另一個頁面，由獨立 dev server
提供；control `:3000` 只有 API，不是 storefront 或 console UI。

## NightWatch custom 邊界

以下不是官方 demo 接口：`demo-adapter:8080/{target}/internal/config`、
`/targets`、`/{target}/healthz`、`/{target}/readyz`，以及 control 的
`/api/*` 和 `:3001/internal/otlp`。它們的規格分別在
[`ADAPTER-CONTRACT.md`](ADAPTER-CONTRACT.md)、[`../API.md`](../API.md)。

## 讀接口時的限制

OTLP receiver 是資料入口，不是官方服務的 health API。receiver 能接受資料只
表示 collector 可接收；service-level readiness 仍要看 manifest check、metrics
與 runtime health。Prometheus、Jaeger 和 control logstore 是不同 projection，
同一時間窗內可能因 batch、sampling 或 retention 而不一致。

容器內 port 與主機映射要分開記錄。整合程式在 compose network 使用 service
hostname；瀏覽器或主機上的檢查使用 compose 對外 published port。不要把
`flagd:8013`、`flagd:8016` 或 `payment:50051` 寫成主機 localhost endpoint，
除非 compose 明確 published 該 port。

新增 upstream service 時，先從官方 compose、環境變數、healthcheck 和 telemetry
resource 找證據，再決定 manifest node id。`service.name`、`peer.service`、
`server.address` 可能不是同一個字串；mapping 要放在 manifest selector 或
adapter target，不能由 console 對單一 id 做 fallback。

## Upstream 與 custom 的責任

官方服務負責產生業務請求、OTLP telemetry 和 flagd evaluation；collector 負責
接收與轉送；Prometheus/Jaeger 負責各自的查詢 projection。NightWatch control
負責 snapshot、evidence、incident 與 approval，demo-adapter 負責 runtime
config translation。這些責任的 custom endpoint、錯誤 envelope 與 revision 語意
不應回寫 upstream image。

實測接口時至少保存 service hostname、主機 port、HTTP status 或 gRPC dial 結果、
一筆 trace/metric/log 的 resource attrs，以及檢查發生時間。沒有 trace 或 log
不代表接口不存在；它只代表該時間窗沒有可觀測資料，應在 wiring inventory 標為
未觀測並保留 health/compose 證據。
