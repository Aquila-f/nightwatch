# 變更紀錄

本文件記錄日日選物示範專案的可辨識變更。`shop-web-eample` 目錄名稱依需求保留 `eample` 拼字。

## [Unreleased] — 2026-09-12

- 建立 `shop-web/` 專案，提供 React + Vite 簡易購物前端與 FastAPI 後端。
- 前端提供商品載入、分類篩選、關鍵字搜尋、購物袋與模擬結帳流程。
- 後端提供健康檢查、商品目錄與訂單 API，使用 SQLite 保存訂單。
- 以 Docker Compose 維持兩個 containers：`frontend` 與 `backend`；前端容器內的 Nginx 負責靜態頁面與 `/api/` proxy。
- 以 `shop-data` named volume 保存 `/data/shop.db`，讓 containers 重建後仍能保留訂單資料。
- 新增 Makefile，集中管理 Docker images 建置、重新建置、啟動、停止、重啟、log、狀態、設定檢查、API 測試、smoke check 與資料清理。
- 新增 `shop-web/README.md` 繁中操作文件，並依指定路徑新增本變更紀錄與 `DISCUSSION.md`。

## 驗證結果 — 2026-09-12

- `make up` 成功建置並啟動 `frontend`、`backend` 兩個 containers。
- `docker inspect` 確認 `frontend` 與 `backend` 均為 healthy。
- `make smoke` 通過首頁與經 Nginx 代理的 `/api/health` 檢查。
- 直接在 backend container 執行 `python -m unittest discover -s tests -v` 顯示 4 tests OK；`make test` 亦以 exit 0 結束，但本機舊 experimental Compose 沒有輸出測試明細。
- backend 重啟前後都確認有相同四筆測試訂單，且 proxy health check 維持 OK，表示訂單資料在重啟後仍可讀取。
- 前端 production build 成功。
- 未執行瀏覽器自動化互動測試。

## 整合紀錄 — 2026-09-12

- 使用者同意繼續 `shop-web/` 並忽略既有 `shop/`；原有 `shop/` 等遠端內容保留，文件使用 `shop-web-eample/docs/`。
- main agent 從 `origin/master` 的 `e12599a` 建立 `feat/integrate-shop-web`，以 `--allow-unrelated-histories` 成功整合本機 `main`；雙方原本的獨立歷史均保留。
- 本次整合尚未 push；後續 `main` fast-forward 結果不在本紀錄中預先宣稱。
