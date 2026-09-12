#!/usr/bin/env bash
# 每個人在自己的筆電跑一次。先 clone,再在 repo 裡跑這支:
#
#   gh repo clone davidleitw/nightwatch-hack
#   cd nightwatch-hack
#   bash setup.sh <部份>
#
# 它會:檢查工具 → 檢查 GitHub → 設好 git → 裝 pre-push hook → 跑一次驗收。
# 不需要 Docker。
#
# 不從管線跑(以前是 gh api ... | bash)。直接 clone 的好處:$0 永遠是真的檔案,
# 抽 pre-push hook 不用繞;抓到的一定是這個 commit 的版本,沒有快取問題。
set -uo pipefail
REPO="davidleitw/nightwatch-hack"; MAIN="master"
part="${1:-}"
fail=0
step(){ printf '\n== %s ==\n' "$1"; }
ok(){ printf '   ✔ %s\n' "$1"; }
warn(){ printf '   ○ %s\n' "$1"; }
bad(){ printf '   ✘ %s\n' "$1"; fail=1; }
die(){ printf '\n✘ %b\n' "$1" >&2; exit 1; }
atleast(){ [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]; }
ver(){ case "$1" in
  go) go version 2>/dev/null|awk '{print $3}'|sed 's/^go//';;
  bun) bun --version 2>/dev/null;;
  node) node --version 2>/dev/null|sed 's/^v//';;
  git) git --version 2>/dev/null|awk '{print $3}';;
  gh) gh --version 2>/dev/null|head -1|awk '{print $3}';;
  codex) codex --version 2>/dev/null|awk '{print $2}';;
  *) printf '';; esac; }
need(){ local n="${1%%>=*}" w="" h; [[ "$1" == *">="* ]] && w="${1#*>=}"
  command -v "$n" >/dev/null || { bad "沒有 $n${w:+(要 $w 以上)}"; return; }
  h=$(ver "$n")
  if [[ -z "$w" || -z "$h" ]]; then ok "$n${h:+ $h}"
  elif atleast "$h" "$w"; then ok "$n $h"
  else bad "$n $h 太舊,要 $w 以上"; fi; }

command -v git >/dev/null || die "沒有 git。macOS:xcode-select --install"

step "1 位置"
# 一定要在 repo 裡面跑。不在就把 clone 指令給他,不自作主張 clone 到別的地方。
root=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [[ -z "$root" || ! -f "$root/setup.sh" ]]; then
  die "要在 repo 裡面跑。先:\n\n      gh repo clone ${REPO}\n      cd ${REPO##*/}\n      bash setup.sh <部份>\n"
fi
ok "repo:${root}"
[[ -f "$root/hackathon.conf" ]] && source "$root/hackathon.conf" || warn "repo 裡沒有 hackathon.conf"
[[ -n "$part" ]] || die "用法:bash setup.sh <部份>${PARTS:+  (${PARTS})}"
case " ${PARTS:-} " in *" $part "*) ;; *) die "部份要填:${PARTS:-問 leader}";; esac
ok "你的部份:${part}"

step "2 工具"
extra="TOOLS_$part"
for t in ${TOOLS:-git gh} ${!extra:-}; do need "$t"; done
if command -v codex >/dev/null 2>&1; then
  [[ -f "$HOME/.codex/auth.json" ]] && ok "codex 已登入" \
    || bad "codex 沒登入,現在就跑 codex login(明天早上才發現會來不及)"
fi

step "3 GitHub"
gh auth status >/dev/null 2>&1 && ok "gh 已登入($(gh api user --jq .login 2>/dev/null))" \
  || bad "gh 沒登入:gh auth login(GitHub.com → SSH)"
git -C "$root" fetch -q origin 2>/dev/null && ok "抓得到 repo" \
  || bad "抓不到 repo —— SSH key 沒設?網路?"
# repo 是 public 的話,沒接受邀請也 fetch 得到 —— 所以要直接問 GitHub 有沒有寫入權。
# 不然隊友會一路綠燈開工,到第一次 push 才發現推不上去。
case "$(gh api "repos/$REPO" --jq .permissions.push 2>/dev/null)" in
  true)  ok "有寫入權(邀請接受了)" ;;
  false) bad "只有讀取權 —— GitHub 的邀請信還沒接受,去信箱或 github.com/notifications 按 Accept" ;;
  *)     warn "問不到權限(gh 沒登入?),等一下 push 才會知道" ;;
esac

step "4 git 設定"
n=$(git -C "$root" config user.name || true); m=$(git -C "$root" config user.email || true)
[[ -n "$n" && -n "$m" ]] && ok "身分:$n <$m>" \
  || bad '還沒設身分:git config --global user.name "名字" && git config --global user.email "信箱"'
git -C "$root" config pull.rebase true && ok "git pull 改成 rebase"
hd=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)/hooks
mkdir -p "$hd"
# 直接 clone 之後 $0 就是 repo 裡的 setup.sh,不必再從別處找
sed -n '/^### PRE-PUSH-HOOK-START/,/^### PRE-PUSH-HOOK-END/p' "$root/setup.sh" | sed '1d;$d' > "$hd/pre-push" 2>/dev/null \
  && chmod +x "$hd/pre-push" && ok "裝好 pre-push(擋住直接推主線)" || warn "pre-push 裝不上(不影響開工)"

step "5 i-am-the-duck"
# 讓 agent 用人話回報做了什麼、依據什麼。
if [[ -f "$root/.agents/skills/duck/SKILL.md" ]]; then
  ok "repo 裡就有 .agents/skills/duck/,codex 會讀到(AGENTS.md 叫它開場載入)"
fi
# 再裝一次 plugin 是為了那個 session-start hook —— 它會自動載入,不必靠 AGENTS.md 提醒。
if ! command -v codex >/dev/null 2>&1; then
  warn "沒有 codex,跳過 plugin"
elif grep -q 'i-am-the-duck@i-am-the-duck.*installed' <<<"$(codex plugin list 2>/dev/null || true)"; then
  ok "plugin 已經裝了"
else
  codex plugin marketplace add davidleitw/i-am-the-duck >/dev/null 2>&1
  codex plugin add i-am-the-duck@i-am-the-duck >/dev/null 2>&1 \
    && ok "plugin 裝好了" || warn "plugin 裝不起來(要 node 18 以上);repo 裡那份還在,不影響開工"
fi

[[ $fail -eq 0 ]] || { printf '\n上面有紅的,先修完。修不動就把這整段貼給 leader。\n'; exit 1; }

if [[ -n "${CHECK_CMD:-}" ]] && [[ -f "$root/${CHECK_CMD##* }" ]]; then
  step "6 跑一次 $CHECK_CMD $part(真正的證明)"
  (cd "$root" && $CHECK_CMD "$part") && ok "驗收全綠" \
    || { printf '\n驗收紅了 —— 這台還做不了事,整段貼給 leader。\n'; exit 1; }
else
  warn "沒有共用的驗收指令 —— 這場不假設每台機器的環境一樣。"
  warn "交出去前自己跑過你做的東西(起服務、curl、點畫面)就算數。"
fi

if [[ -f "$root/task.sh" ]]; then
cat <<MSG

────────────────────────────────────────
你負責:$part
你的目錄:$root/$part/        ← 只准改這底下的東西

每一段任務只用 task.sh,git 指令不用自己打:
  bash task.sh start <NN>      拉新 master、開分支 $part/<NN>-<短名>
  (讓 codex 做事,它讀 AGENTS.md 與 .agents/skills/task-loop/)
  bash task.sh submit          越界還原 → commit → 合 master${CHECK_CMD:+ → $CHECK_CMD} → push → 開 PR
  bash task.sh fix             submit 失敗時,把原因餵回 codex 修,修完再 submit
  bash task.sh done            leader 合併之後:回 master、刪分支

短名與 commit 訊息從任務檔 $part/tasks/<NN>-<短名>.md 來,不用手打。
────────────────────────────────────────
MSG
else
cat <<MSG

────────────────────────────────────────
你負責:$part
你的目錄:$root/$part/        ← 只准改這底下的東西

每做完一段:
  git switch $MAIN && git pull
  git switch -c $part/<NN>-<短名>
  (做事)${CHECK_CMD:+
  $CHECK_CMD $part}
  git add $part && git commit -m "$part <NN>:<做了什麼>"
  git push -u origin $part/<NN>-<短名>
  gh pr create --fill --label part:$part

合併之後:git switch $MAIN && git pull && git branch -D $part/<NN>-<短名>
────────────────────────────────────────
MSG
fi
exit 0

### PRE-PUSH-HOOK-START
#!/usr/bin/env bash
# 擋住直接推主線。真的要推:HACKATHON_ALLOW_MAIN=1 git push ...
set -uo pipefail
while read -r _a _b remote_ref _c; do
  case "$remote_ref" in refs/heads/master|refs/heads/main)
    [[ "${HACKATHON_ALLOW_MAIN:-}" == "1" ]] || { cat >&2 <<'MSG'

  ✘ 不要直接推主線,所有東西走 PR:
      git switch -c <部份>/<NN>-<短名>
      git push -u origin <同一個分支名>
      gh pr create --fill --label part:<部份>

MSG
    exit 1; } ;;
  esac
done
exit 0
### PRE-PUSH-HOOK-END
