# NightWatch 觀測介面

前端只連 Guard Room：`/api/investigator/state`、`/api/investigator/stream`、`/api/detections` 與 graph API。即時 monitor logs 使用 `/events`。不直接連 Investigator，也不解讀模型 SDK 物件。

## 建置與啟動

```sh
python3 guardroom/frontend/build.py
python3 guardroom/frontend/serve.py --port 4173 --control-url http://127.0.0.1:9999
```

或以 `bash guardroom/frontend/restart.sh` 重啟同一 checkout 的 Console。可設定 CONSOLE_PORT 與 NIGHTWATCH_CONTROL_URL；伺服器供應 dist 並代理同源 API。整套服務使用 repo 根目錄 `./restart.sh`。

## 畫面

- `#topology`：即時 graph、異常數、來源狀態、偵測事件與 monitor logs。
- `#detections`：偵測歷史、節點／原因搜尋、持續異常／已恢復篩選與分頁。
- `#detections/{id}`：觸發與恢復時間、連續確認依據、原始節點與完整快照。

AI 調查按鈕停用，明確顯示尚未接入。沒有假的 thinking、report、usage 或修復結果。「觀測已恢復」表示節點 status 連續回到 ok，不代表已驗證根因或業務行為。

事件用 cursor 續傳、去重；state 更新不跳過尚未回放的事件，舊事件不覆蓋較新 detection 狀態。來源離線保留最後收到的資料並標示離線。頁面恢復前景會重連；Monitor logs 不補送斷線期間資料。瀏覽器事件列表有 200 筆上限，完整偵測依據另從詳情 API 取得。

## 拓樸與歷史快照

保留節點搜尋、健康篩選、縮放、全螢幕、全部觀測點與歷史滑桿。Shop 預設顯示六個主要節點，加上 warning／failing、搜尋與選取節點；其他拓樸全量呈現。只顯示實際存在的直接連線。

`GET /api/graph/snapshots` 分頁取得可用歷史，每 5 秒更新；`GET /api/graph?timestamp=...` 讀取不晚於指定時間的保留快照。歷史模式不被即時圖覆蓋，右側偵測與 logs 仍是即時資料。過期或缺少快照會明確報錯，不補造狀態。

## 明確選用的舊示範

`/?source=recording` 與 `serve.py --mock` 仍使用舊錄影展示程式。因此 app.js、data.js、incident-template.html 和 fixtures 保留；它們不是目前 live Investigator 的功能。

## 驗證

```sh
node --test guardroom/frontend/tests/*.test.mjs
```

服務契約見 [INVESTIGATOR.md](../../contracts/INVESTIGATOR.md)。
