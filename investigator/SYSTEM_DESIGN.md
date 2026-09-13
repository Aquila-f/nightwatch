# Investigator 初版架構

## 責任邊界

```text
Monitor → Guard Room graph / logs / history
                    ↑ HTTP polling
             Investigator Observation
                    ↓
               Preprocessor
                    ↓
            SQLite detections + events
                    ↓ HTTP state / events / details
             Guard Room presentation API
                    ↓ same-origin API / SSE
                  Frontend
```

Guard Room 擁有監測資料與前端呈現。Investigator 擁有偵測規則、觸發與恢復依據、持久化事件。兩邊只共享 JSON 契約；Guard Room 不 import Investigator、不讀它的 DB，也不持有模型金鑰。

## 模組

- `observation.py`：Guard Room HTTP adapter，graph schema 與身份驗證，512 KiB 上限、3 秒 timeout。
- `preprocessor.py`：不依賴 HTTP／DB 的逐節點連續觀測判斷。
- `service.py`：觀測排程、來源狀態與異常／恢復持久化。
- `store.py`：單程序 SQLite、排他檔鎖；狀態與事件同一 transaction。
- `models.py`、`api.py`：版本化的公開資料與服務入口。
- Guard Room `investigator_client.py`：HTTP 與 JSON Schema 契約驗證。
- Guard Room `investigator_api.py`：本地 graph 與遠端偵測資料的呈現，並將事件轉成 SSE。

第一版沒有 Runner，也不建立 Investigation／Report 資源。Detection 和 Investigation 的意義刻意區分，避免將「看到症狀」當成「已經開始調查」。

## 同步與中斷

State 的 cursor 和最近偵測在同一個事件迴圈、不含 await 的讀取中取得。初次連線先取得 snapshot 與 cursor；重連使用原本的事件 cursor，不以更新的 state cursor 跳過待回放事件。

Guard Room 每條 SSE 連線約每 2 秒取得 state 與一頁事件；第一版不增加共享背景 worker 或訊息 broker。瀏覽器較多時可將同一來源改成共用 consumer 與 fan-out，而不改 Investigator 契約。

SSE ID 為 `stream_id:cursor`。stream_id 隨資料庫建立且持久化；單純重啟不改變。資料庫替換或 client cursor 超前時發送 reset，明確重新同步。普通斷線保留 cursor 並回放已保存事件。歷史列表依據 detection 的建立 cursor 分頁，事件則有自己的遞增 cursor。

Guard Room 暫存最後一次成功 state；來源離線時標示離線並保留這份狀態，graph 仍從本地讀取。沒有保存完整調查副本，Guard Room 重啟且 Investigator 離線時無法讀歷史；詳情查詢離線回 503。歷史事件不會重複累加或將已恢復 detection 改回 active。

## 持久化

新 named volume `investigator-state` 屬於 Investigator，與 `guardroom-state` 分離。舊 `investigations.sqlite3` 保留原位但不再開啟或遷移。舊 loop、模型套件、案例記憶與 demo 修復程式及其專用測試已移除，可由 Git 歷史取回。

目前每個 detection 保存一次完整觸發 graph，恢復時再保存一次；沒有自動清除政策。相同 graph 觸發多個節點時會重複保存；大規模部署可再引入共用 snapshot 儲存與 retention。兩個服務均維持一個 worker，不支援多副本共寫同一資料目錄。

## 下一階段：Runner

新增調查執行前，先加入 Investigation Service，管理 `pending → running → completed / failed / interrupted`、持久化待處理工作、request_id 去重與同時執行數限制。

Runner 接收 investigation 任務、觀測查詢介面與事件回報 callback；不 import FastAPI、不直接寫 SQLite。第一版可以順序執行工具。對外回報產品層的 `investigation.progress`（可公開摘要）、`evidence.recorded`、完成／失敗事件；不得把模型 SDK／raw reasoning 物件作為前端契約。

Report 和 Evidence 應獨立可查，完成事件引用 report ID。正式接入時以版本化契約增加這些類型、驗證證據引用、實作重啟中斷處理，再開啟手動與自動調查。現在不預先發布尚未實作的欄位或模擬輸出。
