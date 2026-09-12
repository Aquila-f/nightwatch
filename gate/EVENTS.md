# gate 事件:`events.jsonl` 的欄位

一行一筆 JSON。只有 `gate.sh` 寫(watch 迴圈、skill、leader 都是透過它),儀表板唯讀。
8 小時大約 30–60 筆(15–25 條 PR,加上退回與跟進)。設了驗收指令的話,輸出在 `logs/<pr>-<sha>.log`,codex 回報全文在 `reports/<pr>-<sha>.md`,事件只放路徑。

## kind

| kind | 誰寫 | 意思 |
|---|---|---|
| `day_start` | leader(`gate.sh start`) | 儀表板的 t=0 |
| `merged` | script | 驗過、squash 進主線了 |
| `held` | script | 有擱置原因,等 skill / leader |
| `returned` | agent / leader | 退回給實作者,PR 留言已貼 |
| `env` | agent / leader | 紅的是環境的錯,不算這條 PR;下一輪重驗 |
| `answered` | agent / leader | 契約疑問回答了;之後不因疑問擱置 |
| `note` | leader | 砍範圍、換模型、環境事故等隨手記 |

同一條 PR 的一生:`held`(第 1 次)→ `returned` → 對方推新 commit → `held`(第 2 次)→ `returned` → … → `merged`。`attempt` 是第幾次驗。

## 欄位(`merged` / `held` 全有;跟進事件只有識別欄位 + `note`)

| 欄位 | 型別 | 例 | 為什麼要 |
|---|---|---|---|
| `ts` | string ISO 本地時間 | `2026-09-13T11:42:07+08:00` | 時間軸 |
| `kind` | string | `merged` | 上表 |
| `by` | `script` / `agent` / `leader` | `script` | 「誰決定的」;評審看得出確定性的事沒有交給模型 |
| `pr` | int | `17` | 識別 |
| `sha` | string 12 碼 | `3f9c2a1b7d0e` | 同一 PR 推新 commit 要重驗;squash 後 head 會消失,不記就沒了 |
| `branch` `part` `nn` | string | `shop/03-pool-leak` `shop` `03` | 每個部份的進度、跟 README §2 的段對上 |
| `title` `author` | string | | 顯示 |
| `attempt` | int | `2` | 「退三次才過」的證據 |
| `opened_at` | string ISO(UTC,gh 給的) | | PR 開到合併的總時間 |
| `head_at` | string ISO | | head commit 的時間;squash 刪分支後拿不到 |
| `wait_secs` | int | `241` | head 推上來 → 本次判定,gate 的反應時間 |
| `files` | int | `4` | 大小 |
| `outside` | string[] | `["hackathon/contracts/API.md"]` | 碰到別人目錄的檔,空的就是乾淨 |
| `self` | `{check,secs,files}` | `{"check":"pass","secs":63,"files":4}` | 實作者(codex)首行註解自己說的;跟 `check` 對照 = 「自報綠、實測紅」的次數 |
| `check` | `{ran,pass,secs,failed[],log}` | `{"ran":true,"pass":false,"secs":41,"failed":["go test(exit 1)"],"log":"logs/17-3f9c2a1b7d0e.log"}` | gate 實測;`failed` 是驗收輸出的 ✘ 行 |
| `reasons` | string[] | `["check_red","contract_question"]` | 擱置原因,可多個;空 = 合併 |
| `waived` | string[] | `["no_screenshot"]` | 這條 PR 被免除的原因(leader 決定的) |
| `questions` | string ≤500 | | 契約疑問原文;答了才能合 |
| `shots` | bool | `true` | 前端有沒有附截圖證據 |
| `mergeable` | string | `MERGEABLE` | GitHub 當時算的 |
| `base_sha` | string 12 碼 | | 驗的時候主線在哪 |
| `merge_sha` | string 12 碼 / null | | 進主線的 squash commit |
| `report` | string | `reports/17-3f9c2a1b7d0e.md` | codex 回報全文(做了什麼 / 依據什麼驗證 / 沒驗證 / 疑問) |
| `note` | string | | 自由文字一行:退回理由、環境修了什麼、格式哪裡錯 |

## reasons

| 值 | 誰判 | 意思 |
|---|---|---|
| `check_red` | script 擋、agent 判 | 驗收指令非零(沒設 CHECK_CMD 就不會出現) |
| `no_screenshot` | script 擋、agent 判 | 前端 PR 沒有 png / 內文沒圖 |
| `contract_question` | script 擋、leader 答 | 回報「契約疑問」不是無 |
| `conflict` | script 擋、agent 退 | GitHub 說 CONFLICTING,或 gate 裡合 `origin/master` 失敗 |
| `bad_format` | script 擋、agent 退 | 分支名 / 標籤 / 首行註解不合 |
| `outside_dir` | script 擋、agent 退 | diff 碰到 `hackathon/<part>/` 以外 |
| `merge_failed` | script | `gh pr merge` 失敗(保護規則、API);重跑 `gate.sh merge N` |

## 儀表板算得出來的

- 時間軸:每個 `merged` / `held` / `returned` 一個點,x = `ts`,泳道 = `part`
- 每個部份走到第幾段:`merged` 的 `nn` 最大值 / README §2 的段數
- 通過率:`merged` ÷ (`merged` + `held`);第一次就過的比例:`attempt==1` 的 `merged`
- gate 反應時間:`wait_secs` 的中位數;`check.secs` 的分佈
- 自報 vs 實測:`self.check=="pass"` 且 `check.pass==false` 的筆數
- 退回原因分佈:`reasons` 展開計數
