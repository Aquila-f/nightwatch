# 討論紀錄

本文件保留需求、取捨與交付脈絡；目錄名稱 `shop-web-eample` 及檔名依指定保留。

## 2026-09-12｜需求與工作範圍

- 使用者要求製作一個簡易購物前端，前端 framework 可由實作方選擇。
- 後端指定使用 FastAPI。
- Compose 部署限定為兩個 containers；本實作將服務分為 `frontend` 與 `backend`，Nginx 放在前端 container 內處理靜態頁面與 API proxy。
- 使用者要求以 Makefile 說明 Docker 建置指令及日常操作，因此將 build、rebuild、up、down、stop、restart、logs、ps、config、test、smoke、clean 統一收斂到 `shop-web/Makefile`。

## 2026-09-12｜路徑與分支約定

- 實際程式碼放在 `shop-web/`。
- 變更紀錄與討論紀錄放在 `shop-web-eample/docs/`，刻意保留 `eample` 字樣以符合使用者指定。
- 實作分支為 `feat/simple-shop`；需求流程包含完成後將成果添加到 `main`。

## 2026-09-12｜實作決策

- 前端採 React 19 + Vite，使用瀏覽器 `localStorage` 暫存購物袋。
- 後端以 Pydantic 驗證訂單欄位，並以伺服器端商品目錄與價格計算訂單總額。
- SQLite 檔案位於 `/data/shop.db`，掛載到 Compose 的 `shop-data` named volume；`make down` 保留資料，`make clean CONFIRM=yes` 才移除資料。
- 對外預設入口為前端 `localhost:8080`，後端 API 文件為 `localhost:8000/docs`；瀏覽器的 `/api/` 請求由 Nginx 轉送至 backend。

## 2026-09-12｜驗證結果

- `make up` 成功建置並啟動 `frontend`、`backend` 兩個 containers，`docker inspect` 顯示兩者均為 healthy。
- `make smoke` 通過首頁與經 Nginx proxy 的 `/api/health`。
- 直接執行 `docker exec nightwatch-shop-web_backend_1 python -m unittest discover -s tests -v` 顯示 4 tests OK；`make test` 也 exit 0，但本機舊 experimental Compose 不輸出測試明細。
- backend 重啟前後確認相同四筆測試訂單仍在，proxy health 也維持 OK。
- 前端 production build 成功；未做瀏覽器自動化互動測試。
- 詳細驗證結果已更新至 `CHANGELOG.md`。

## 2026-09-12｜協作時間線

- 初版由 main agent 在使用者補充協作要求前建立。
- 使用者補充協作要求後，改由 subagent `gpt-5.6-luna max` 接手實作、檢查與修正。
- main agent 統籌整合驗證，完成後依需求將 `feat/simple-shop` 成果添加到 `main`。

## 2026-09-12｜本次整合紀錄

- 使用者同意繼續 `shop-web/` 並忽略既有 `shop/`；原有 `shop/` 等遠端內容保留，文件使用 `shop-web-eample/docs/`。
- main agent 從 `origin/master` 的 `e12599a` 建立 `feat/integrate-shop-web`，再以 `--allow-unrelated-histories` 成功整合本機 `main`；雙方原本的獨立歷史均保留。
- 本次整合尚未 push；後續 `main` fast-forward 結果留待主 agent 回覆，不在此預先宣稱。
