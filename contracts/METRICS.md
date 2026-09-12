# 契約 3:量測訊號(官方 OTel Demo → collector → Prometheus / Jaeger / control)

這是官方 OpenTelemetry Demo 3.0.0 與 control 之間最容易爆的接縫:Demo 與 `demo-adapter` 用 OpenTelemetry 報資料,collector 再產生 span metrics / service graph 並送往 Prometheus、Jaeger、control。這裡釘死來源、Prometheus 名稱與查詢句;標成**未驗證**的名稱要在整套起來後對名。

## 1. 資料怎麼流

```
官方 Demo 服務 + demo-adapter ──OTLP──▶ otel-collector
                                          │
                                          ├─ metrics(OTLP + receivers + span_metrics / service_graph)──▶ Prometheus OTLP receiver
                                          ├─ traces ───────────────────────────────────────────────────▶ Jaeger
                                          └─ logs ──filter/no_flag_leak──OTLP/HTTP JSON───────────────▶ control :3001 /internal/otlp
```

三條 pipeline 以 [`hackathon/oteldemo/otel/collector.yaml`](../oteldemo/otel/collector.yaml) 為準:

- `metrics`:收 `otlp`、`span_metrics`、`service_graph`、`redis`、`postgresql`、`kafka_metrics`、`nginx`、`prometheus/ad`,送 Prometheus 的 OTLP receiver。
- `traces`:收 `otlp`,經 `transform/sanitize_spans`,一份送 Jaeger,另兩份交給 `span_metrics` 與 `service_graph` connector。
- `logs`:收 `otlp`,先經 `filter/no_flag_leak`,再以不壓縮的 OTLP/HTTP JSON 送 control。

`span_metrics` 每 5 秒 flush,buckets 到 10 秒。`service_graph` 每 5 秒 flush、store TTL 10 秒;`virtual_node_peer_attributes` 依序是 `server.address`、`peer.service`、`messaging.system`。刻意不放 `db.system.name`,避免產生名叫 `postgresql` / `redis` 的虛擬節點。

## 2. 官方 Demo 報什麼

所有圖上節點的 resource 都設 `service.name=<node id>`、`service.namespace=shop`,因此 Prometheus 的 `job` 是 `shop/<service>`(**已端到端驗證**)。`service.name` 必須與 `manifest.yaml` 的 node id 相同。瀏覽器端的 `frontend-web` 是額外的 trace resource,不是圖上的 node。

逐服務事實來自 [services-1](../docs/oteldemo-sweep/services-1.md) 與 [services-2](../docs/oteldemo-sweep/services-2.md);collector / Prometheus 的已驗證行為來自 [infra](../docs/oteldemo-sweep/infra.md)。

### 2.1 官方服務的 signals

span 屬性依各服務語言的 auto-instrumentation 而異;下表只列 control 會用到或排查時重要的鍵。凡由第三方 instrumentation 自動產生而未跑 live trace 對過的,都視為未驗證。

| service | span kind / 重要屬性 |
|---|---|
| `frontend-proxy` | Envoy HTTP downstream / upstream span;HTTP 路由以 `http.route` 正規化,server / peer 資訊由 Envoy instrumentation 產生 |
| `frontend` | HTTP server 與 gRPC client;gRPC client 預期有 `rpc.service`、`rpc.method`、`server.address`,例如 `rpc.service=oteldemo.CartService` |
| `product-catalog` | gRPC server + SQL client;實跑 client span 有 `db.system.name=postgresql` 與 `server.address=astronomy-db` |
| `cart` | gRPC server + Redis client;實跑 client span 只有 `server.address=valkey-cart`,沒有 `db.system.name` |
| `checkout` | gRPC / HTTP client 預期有 `rpc.service`、`rpc.method`、`server.address`;Kafka producer span `orders publish` 明確帶 `messaging.system=kafka`、`peer.service=kafka`、`messaging.destination.name=orders` |
| `payment` | gRPC server 預期有 `rpc.service=oteldemo.PaymentService`、`rpc.method=Charge`;失敗 span status 是 error,錯誤字串含 `Payment request failed. Invalid token.` |
| `currency` | 手寫 server span 帶 `rpc.service=oteldemo.CurrencyService`、`rpc.method`;失敗看 span status,不要用其寫死為成功的 `rpc.grpc.status_code` |
| `shipping` | HTTP server + 呼叫 quote 的 HTTP client;client 預期有 `server.address`、HTTP method / status |
| `quote` | HTTP server + internal `calculate-quote`;沒有業務出站 |
| `email` | HTTP server + internal `send_email`;`demo.order.id` |
| `recommendation` | gRPC server + product-catalog gRPC client;預期有 `rpc.service=oteldemo.ProductCatalogService`、`rpc.method=ListProducts`、`server.address` |
| `ad` | gRPC server;RPC 屬性由 Java agent 產生 |
| `image-provider` | nginx HTTP span;沒有業務出站 |
| `load-generator` | client span 與手寫使用者旅程 span;每個請求帶 `synthetic_request=true` baggage |
| `accounting` | Kafka consumer span;預期 `messaging.system=kafka`;實跑 DB client span 有 `db.system.name=postgresql` 與 `server.address=astronomy-db` |
| `fraud-detection` | Kafka receive / process span;預期 `messaging.system=kafka`,其餘 messaging 鍵受 Java agent semconv 版本影響 |
| `kafka` | broker 本身沒有應用層 producer / consumer span;主要看 JMX 與 `kafka_metrics` receiver |

官方服務的自訂 metrics 可作排查證據,但節點四軸以 §3 的 connector / k6 查詢為準。合成流量由 k6 內建 `--out opentelemetry` 匯出,設定前綴 `k6.`。前三個 control 使用的 Prometheus 名稱已實跑驗證:

| k6 instrument | Prometheus 名稱 | 用途 |
|---|---|---|
| `k6.http_reqs` | `k6_http_reqs_total` | 合成 HTTP traffic |
| `k6.http_req_failed` | `k6_http_req_failed_total` | 依 `condition` 分列;`nonzero` 是失敗、`zero` 是成功 |
| `k6.http_req_duration` | `k6_http_req_duration_milliseconds_bucket` / `_sum` / `_count` | HTTP latency |
| `k6.iterations` | `k6_iterations_total` | iteration 數 |
| `k6.vus` | `k6_vus` | VU 數 |
| `k6.data_sent` / `k6.data_received` | `k6_data_sent_bytes_total` / `k6_data_received_bytes_total` | 傳輸量 |

collector 的 `kafka_metrics` receiver 開 `brokers`、`topics`、`consumers` scraper。consumer lag 已實跑驗證為 `kafka_consumer_group_lag_ratio{group,topic,partition}`;instrument unit 是 1,Prometheus 會補 `_ratio`。control 集中用 `max(kafka_consumer_group_lag_ratio{group=~".+"})`。

OTLP logs 不能假設每個服務都有。**`payment`、`frontend` 不送 OTLP logs**,故障判斷必須以 span status / metrics 為主。其餘服務也可能只有特定路徑會寫 log,不能用「沒有 error log」推成健康。collector 會丟掉 body 符合 `(?i)feature ?flag` 或 `(?i)flagd` 的紀錄,避免 feature-flag 名稱直接洩題。

### 2.2 demo-adapter 唯一自報的指標

| instrument | 型別 | 屬性 | Prometheus 名稱 |
|---|---|---|---|
| `shop.config.revision` | gauge,值固定 1 | `revision="v1\|v2"`;resource `service.name=<target>`、`service.namespace=shop` | `shop_config_revision{job="shop/<target>",revision="..."}` |

`demo-adapter` 不補官方服務的 traffic / error / latency 指標;它只替每個 target 報這一顆 revision gauge。

`shop_config_revision{job="shop/<target>",revision}` 已實跑驗證在每個 adapter target 都有值。

### 2.3 collector 從 trace 算出的指標

`span_metrics` 的自訂 dimension 經 Prometheus 轉成底線 label:`peer_service`、`db_system_name`、`db_system`、`messaging_system`、`http_route`、`rpc_service`、`rpc_method`、`server_address`。

| 名稱 | 主要標籤 | 意思 |
|---|---|---|
| `traces_span_metrics_calls_total` | `service_name` `span_name` `span_kind` `status_code` + 上述八個 dimension | 每種 span 次數 |
| `traces_span_metrics_duration_milliseconds_bucket` | 同上 + `le` | 每種 span 的延遲分佈 |
| `traces_service_graph_request_total` | `client` `server` | 服務對服務呼叫次數 |
| `traces_service_graph_request_failed_total` | `client` `server` | 服務對服務失敗次數 |
| `traces_service_graph_request_server_seconds_bucket` | `client` `server` `le` | 服務對服務延遲分佈 |

實跑的 `traces_service_graph_request_total` 配對包括 checkout→kafka、product-catalog→astronomy-db、cart→valkey-cart。另有 manifest 未宣告的 `flagd`、`unknown`、`user` 節點;control 會忽略。

## 3. control 對 Prometheus 的查詢句(照抄,不要自己發明)

通則:

1. 所有 `rate()` 視窗一律 30 秒;只有 liveness 依下表用 15 秒。
2. 所有除法分母一律包 `clamp_min(..., 0.001)`。
3. selector 由 manifest node 的 `selector` 展開成 Prometheus labels;沒給時預設 `peer_service="<node id>"`。
4. 一律用 instant query `GET /api/v1/query?query=...`;每 5 秒取樣。

### 服務類節點(`kind: service`)

一次查全部,再依 `service_name` 分。revision 對所有 service 查,不再寫死服務名。

| 軸 | PromQL |
|---|---|
| traffic | `sum by (service_name) (rate(traces_span_metrics_calls_total{span_kind=~"SPAN_KIND_SERVER\|SPAN_KIND_CONSUMER"}[30s]))` |
| errors | `(sum by (service_name) (rate(traces_span_metrics_calls_total{span_kind=~"SPAN_KIND_SERVER\|SPAN_KIND_CONSUMER",status_code="STATUS_CODE_ERROR"}[30s])) or sum by (service_name) (rate(traces_span_metrics_calls_total{span_kind=~"SPAN_KIND_SERVER\|SPAN_KIND_CONSUMER"}[30s])) * 0) / clamp_min(sum by (service_name) (rate(traces_span_metrics_calls_total{span_kind=~"SPAN_KIND_SERVER\|SPAN_KIND_CONSUMER"}[30s])), 0.001)` |
| latency(p95 ms) | `histogram_quantile(0.95, sum by (service_name, le) (rate(traces_span_metrics_duration_milliseconds_bucket{span_kind=~"SPAN_KIND_SERVER\|SPAN_KIND_CONSUMER"}[30s])))` |
| liveness | `count by (service_name) (count_over_time(traces_span_metrics_calls_total{service_name=~".+"}[15s]))` 有值,或 manifest 的 `health_url` 成功 |
| revision | `topk(1, timestamp(shop_config_revision{job="shop/<service>"}))`,取結果的 `revision` label |
| saturation | `null`;官方服務沒有統一、已驗證且可跨語言使用的 saturation 指標 |

### 合成節點(`kind: synthetic`)

三個名稱已實跑驗證。R1/R2 的 customer SLI 只算 k6 的 checkout API (`name="http://frontend-proxy:8080/api/checkout"`);瀏覽、catalog 與 flagd OFREP 請求不應稀釋結帳結果。`k6_http_req_failed_total` 必須只取 `condition="nonzero"`;完全沒有失敗時該序列不存在,errors 用 `or ... * 0` 補 0。

| 軸 | PromQL |
|---|---|
| traffic | `sum(rate(k6_http_reqs_total{name="http://frontend-proxy:8080/api/checkout"}[30s]))` |
| errors | `(sum(rate(k6_http_req_failed_total{condition="nonzero",name="http://frontend-proxy:8080/api/checkout"}[30s])) or sum(rate(k6_http_reqs_total{name="http://frontend-proxy:8080/api/checkout"}[30s])) * 0) / clamp_min(sum(rate(k6_http_reqs_total{name="http://frontend-proxy:8080/api/checkout"}[30s])), 0.001)` |
| latency(p95 ms) | `histogram_quantile(0.95, sum by (le) (rate(k6_http_req_duration_milliseconds_bucket{name="http://frontend-proxy:8080/api/checkout"}[30s])))` |
| liveness | `sum(rate(k6_http_reqs_total{name="http://frontend-proxy:8080/api/checkout"}[30s])) > 0` |
| extras | `requests_per_s` = traffic;`fail_ratio` = errors |

### Datastore 節點(`kind: datastore`)

`<selector>` 是 node 的 selector。manifest 的 astronomy-db 展開成 `server_address="astronomy-db"`,valkey-cart 展開成 `server_address="valkey-cart"`;前者的 live span 另有 `db_system_name="postgresql"`,後者沒有 `db_system_name`。

| 軸 | PromQL |
|---|---|
| traffic | `sum(rate(traces_span_metrics_calls_total{span_kind="SPAN_KIND_CLIENT",<selector>}[30s]))` |
| errors | `(sum(rate(traces_span_metrics_calls_total{span_kind="SPAN_KIND_CLIENT",status_code="STATUS_CODE_ERROR",<selector>}[30s])) or sum(rate(traces_span_metrics_calls_total{span_kind="SPAN_KIND_CLIENT",<selector>}[30s])) * 0) / clamp_min(sum(rate(traces_span_metrics_calls_total{span_kind="SPAN_KIND_CLIENT",<selector>}[30s])), 0.001)` |
| latency(p95 ms) | `histogram_quantile(0.95, sum by (le) (rate(traces_span_metrics_duration_milliseconds_bucket{span_kind="SPAN_KIND_CLIENT",<selector>}[30s])))` |
| saturation | `null` |
| liveness | `sum(rate(traces_span_metrics_calls_total{span_kind="SPAN_KIND_CLIENT",status_code!="STATUS_CODE_ERROR",<selector>}[15s])) > 0` |

### Queue 節點(`kind: queue`)

Kafka node 的 selector 是 `messaging_system="kafka"`,owner 是 `fraud-detection`;producer span 也有 `peer_service="kafka"`。lag 名稱已實跑驗證。

| 軸 | PromQL / 規則 |
|---|---|
| traffic | `sum(rate(traces_span_metrics_calls_total{span_kind="SPAN_KIND_PRODUCER",messaging_system="kafka"}[30s]))` |
| errors | `null` |
| latency | `null` |
| saturation | `max(kafka_consumer_group_lag_ratio{group=~".+"})` |
| liveness | 跟 owner 節點 |
| extras | `consumer_lag` = `max(kafka_consumer_group_lag_ratio{group=~".+"})`;`depth` = 同值 |

### External 節點(`kind: external`)

用 manifest selector;沒給時預設 `peer_service="<id>"`。

| 軸 | PromQL / 規則 |
|---|---|
| traffic | `sum(rate(traces_span_metrics_calls_total{span_kind="SPAN_KIND_CLIENT",<selector>}[30s]))` |
| errors | `(sum(rate(traces_span_metrics_calls_total{span_kind="SPAN_KIND_CLIENT",status_code="STATUS_CODE_ERROR",<selector>}[30s])) or sum(rate(traces_span_metrics_calls_total{span_kind="SPAN_KIND_CLIENT",<selector>}[30s])) * 0) / clamp_min(sum(rate(traces_span_metrics_calls_total{span_kind="SPAN_KIND_CLIENT",<selector>}[30s])), 0.001)` |
| latency(p95 ms) | `histogram_quantile(0.95, sum by (le) (rate(traces_span_metrics_duration_milliseconds_bucket{span_kind="SPAN_KIND_CLIENT",<selector>}[30s])))` |
| liveness | 有 client traffic 就活;沒有 traffic 也視為活(外部或備援可能平時沒人叫) |

### 邊

| edge kind | PromQL / observed 規則 |
|---|---|
| `calls` | rps `sum by (client, server) (rate(traces_service_graph_request_total[30s]))`;errors 是 `sum by (client, server) (rate(traces_service_graph_request_failed_total[30s])) / clamp_min(sum by (client, server) (rate(traces_service_graph_request_total[30s])), 0.001)`;p95 是 `histogram_quantile(0.95, sum by (client, server, le) (rate(traces_service_graph_request_server_seconds_bucket[30s]))) * 1000` |
| `uses` | client span:`{service_name="<from>",span_kind="SPAN_KIND_CLIENT",<to selector>}`;有 traffic 就 observed |
| `publishes` | producer span:`{service_name="<from>",span_kind="SPAN_KIND_PRODUCER",<to selector>}`;有 traffic 就 observed |
| `consumes` | consumer span:`{service_name="<from>",span_kind="SPAN_KIND_CONSUMER",<to selector>}`;有 traffic 就 observed |
| `calls` 到 external | client span:`{service_name="<from>",span_kind="SPAN_KIND_CLIENT",<to selector>}`;有 traffic 就 observed |

### 節點詳情才查的(`get_node_detail`)

- `top_error_spans`:`topk(3, sum by (span_name) (rate(traces_span_metrics_calls_total{service_name="<node>",status_code="STATUS_CODE_ERROR"}[30s])))`
- `top_slow_spans`:`topk(3, histogram_quantile(0.95, sum by (span_name, le) (rate(traces_span_metrics_duration_milliseconds_bucket{service_name="<node>"}[30s]))))`

## 4. control 對 Jaeger 的查詢

Jaeger v2 的 v1 相容 API 不變:

| 用途 | 呼叫 |
|---|---|
| 找 trace | `GET /api/traces?service=<name>&lookback=<n>m&limit=<n>`(可加 `&tags={"error":"true"}` 篩錯的) |
| 讀一筆 | `GET /api/traces/<trace_id>` |
| 服務清單(readiness 用) | `GET /api/services` |

回應是 `{"data":[{"traceID","spans":[{"spanID","operationName","references","startTime","duration","tags":[{"key","value"}],"process":{"serviceName"}}],"processes":{...}}]}`。`startTime` 是微秒。

## 5. 對名的方法(整合檢查點用)

Prometheus 先列實際名稱:

```sh
curl -s 'http://<prom>/api/v1/label/__name__/values' \
  | python3 -m json.tool \
  | grep -E 'traces_|k6_|kafka_|shop_config_revision'
```

再查關鍵 labels:

```sh
curl -sG 'http://<prom>/api/v1/query' \
  --data-urlencode 'query=count by (service_name,db_system_name,server_address,rpc_service,rpc_method,messaging_system,peer_service,http_route) (traces_span_metrics_calls_total)'
curl -s 'http://<jaeger>/api/services'
```

逐一對 §2.2、§2.3 與 §3。`k6_*`、Kafka lag、cart Redis selector 已於 2026-09-11 live 驗證;日後名稱或型別不符時,一起改本契約與 control 集中的查詢常數,不要在多處各自猜名字。
