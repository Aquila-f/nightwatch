---
name: task-loop
description: NightWatch hackathon task wrap-up and repair loop. Apply at the end of every task, and whenever the prompt's 「補充:」 hands back a `task.sh submit` failure (first line `task.sh submit 失敗:<kind>`, kind `merge 衝突`, `merge 衝突(不在你的目錄)` or `驗收紅`) — then follow only the matching part.
---

# Task wrap-up and repair loop

- One-day hackathon repo. Three parts at the root, one owner each: `shop/`, `control/`, `console/`. You work only inside your own `<part>/`; repo root is `..`.
- `contracts/` is read-only and the only way to learn a neighbour's interface. Never read a neighbour's code.
- A human runs `bash task.sh submit` (commit → merge `origin/master` → push → PR); the sandbox cannot write `.git`, so no git beyond `status`/`diff`/`log`. Make submit pass first time.
- No shared acceptance command: verification means running what you built.
- Rejects the whole PR: any edit outside `<part>/`. Parks the PR: anything but 「無」 or a real question under `## 契約疑問`. Full rules in `AGENTS.md`.

## Before you finish (every task)

1. Run what you built (start the service, curl it, exercise the screen); meet every acceptance criterion in the task file. Not run → 「沒有驗證的」 with the reason. Shut down what you started.
2. `git status --porcelain`. Paths outside `<part>/`: delete files you created; leave modified files alone — submit reverts them to master, keeps your version in `<part>/.codex/outside/<original path>`, and adds a 「越界還原」 note to the PR. What that path needed goes under 「契約疑問」. If asked to redo it: get the same result inside `<part>/`, or write the needed change under 「契約疑問」 and do not touch that file again.
3. Your last message is the report, saved to `<part>/.codex/<NN>.last.md` and pasted into the PR body. Traditional Chinese, four headings verbatim, in this order:
   `## 做了什麼`, `## 依據什麼驗證的`, `## 沒有驗證的`, `## 契約疑問`
   Bullets: commands run and what they printed. Empty section: 「無」. No process narrative. `gate.sh` parses `## 契約疑問`; only real contract questions, e.g.
   ```
   ## 契約疑問
   - API.md §3 的 `/api/state` 沒寫 `incidents` 為空時要回 `[]` 還是省略;先回 `[]`(假設)。
   ```

## When 「補充:」 hands back a submit failure

First line `task.sh submit 失敗:<kind>` (same text in `<part>/.codex/<NN>.fail.md`). Fix only what that kind lists, nothing else. This round's report covers only this round; task.sh appends it to the PR as 「第 N 輪」. No git commands.

- `merge 衝突`: listed files contain `<<<<<<< HEAD`, `=======`, `>>>>>>> origin/master`. `<<<<<<<` to `=======` is this task's version; `=======` to `>>>>>>>` is what the leader merged into master; a `|||||||` block between is the common ancestor — drop it entirely. Keep both intents. Done when `grep -rnE '^(<{7}|={7}|>{7}|\|{7})' . --exclude-dir=node_modules --exclude-dir=.codex` prints nothing (submit runs the same grep over `<part>/`), then run the merged code once more. The merge is in progress; submit makes the closing commit.
- `merge 衝突(不在你的目錄)`: merge aborted, conflict outside `<part>/`. Nothing to fix; say so in the report, the leader handles it.
- `驗收紅`: only if the leader set `CHECK_CMD` in `hackathon.conf`; submit ran `<CHECK_CMD> <part>` and handed back every `✘` line plus the last 60 lines of output (full log: `<part>/.codex/<NN>.check.log`). Fix only those items.
