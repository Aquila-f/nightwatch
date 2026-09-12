---
name: merge-loop
description: Leader-side review → merge → record for nightwatch-hack. Use when asked to process PRs that gate.sh has held. gate.sh does everything deterministic; this skill makes the judgment calls and never merges by hand. No acceptance command is configured, so nothing is built or tested.
---

- Repo: one-day hackathon. Parts `shop/ control/ console/` at the root, one owner each; `contracts/` shared, read-only. PR bodies carry four verbatim headings `## 做了什麼`, `## 依據什麼驗證的`, `## 沒有驗證的`, `## 契約疑問`.
- `gate` = `bash gate/gate.sh` from repo root. Holds a PR unless: branch `<part>/<NN>-<name>`; `part:` label and first-line `nightwatch` annotation agree with it; diff stays inside `<part>/`; `## 契約疑問` is `無`; `console` PRs carry a screenshot; merges cleanly with `origin/master`. Record: `gate/events.jsonl` (fields `gate/EVENTS.md`), PR body copy `gate/reports/<pr>-<sha>.md`.
- `gate` builds and runs nothing (`CHECK_CMD` in `hackathon.conf` is empty). A merge proves shape and ownership, not that the code works. If the leader sets `CHECK_CMD`, `check_red` reappears with output in `gate/logs/<pr>-<sha>.log`.

## Setup
1. `gate doctor`; fix red first. `check 沒設定,PR 只驗格式/目錄/合併/契約疑問` is normal.
2. `gate held` — prints `#N <branch> <sha> 第X次 reasons= failed= log= report= waived=` plus `疑問:` / `note:` lines. Empty → reply "no held PRs", stop.
3. One PR at a time: lower `nn` first, same part together.

## Never
- No `gh pr merge`, no `git merge`. Merge only via `gate merge`.
- Don't edit or fix the PR branch; return it.
- No "probably fine". Act on the reason `gate held` prints, per the table; quote its `note:` line. Never vouch that the code works.
- Every decision goes through `gate return|merge|env|answer`. Not in `events.jsonl` = didn't happen.
- One gate worktree, one lock. `gate merge`/`show` wait for the `watch` loop.
- Text passed to `gate return|env|answer` is read by teammates in Traditional Chinese — write it in Chinese.

## Held reason → action

| reason | action |
|---|---|
| `no_screenshot` | `console` only. `gh pr diff N --name-only`. No `.tsx` `.css` (tests/types/data only) → `gate merge N no_screenshot`. UI touched → `gate return N "console 段要附瀏覽器截圖:png 進 diff 或貼在 PR 內文"`. png present but unrecognized → `gate show N`, look: no error bar, matches the task's screen → `gate merge N no_screenshot`. |
| `contract_question` | Give the leader the `疑問:` text and your one-line answer. Leader answers → `gate answer N "<答案>"`. Leader changes the contract → wait until `contracts/` is updated on master, then `gate answer N "<改了什麼>"`. Never answer or edit `contracts/` yourself. |
| `conflict` | `gate return N "跟 master 衝突,rebase 到最新 master 再推"`. Lower-`nn` PR in same part still open → `等 #<那條> 合了再 rebase` instead. |
| `bad_format` | `gate return N "<note 原文>;格式:分支 <部份>/<NN>-<短名>、標籤 part:<部份>、內文第一行 nightwatch 註解"`. |
| `outside_dir` | `gate return N "碰到別人的目錄:<outside 列表>,拿掉再推"`. Leader explicitly allows → `gate merge N outside_dir`. |
| `merge_failed` | Read `note`; `gate merge N` once more. Still failing → note to leader. |

Multiple reasons: clear all, then `gate merge N r1,r2`; if any needs a return, return once listing every reason. Waivers persist in `gate/state/<N>.waive` — waive only what the table says.

## Report to the leader
One line per PR: `#N <branch> → merged | returned(<reason>) | waiting on you: <one-line question>`. Last line: PRs still held, when you'll next run `gate held`.
`gate/state/heartbeat` older than 5 minutes → `watch` isn't running; say so in the first line.
