#!/usr/bin/env bash
# 一段任務的 git 流程,人打,codex 不碰(沙箱寫不了 .git)。
#
#   bash task.sh start <NN> [shop|control|console]   master 拉新、開分支 <部份>/<NN>-<短名>;上一段合併了就順手刪
#   bash task.sh submit                               越界還原 → commit → merge master → 驗收(有設才跑) → push → 開 PR(已有就更新)
#   bash task.sh fix                                  把上一次 submit 的失敗餵給 codex 修(run-task.sh 帶補充),修完再 submit
#   bash task.sh done                                 leader 合併後:回 master、刪分支(start 也會做,這條可省)
#
# 部份可以在 hackathon.conf 寫 PART=shop,之後 start 只要給 NN。
# 短名與 commit 訊息都從任務檔 <部份>/tasks/<NN>-<短名>.md 的檔名與第一行來,不用手打。
# submit 失敗會把原因寫到 <部份>/.codex/<NN>.fail.md,fix 就是把這個檔丟給 codex。
set -uo pipefail
root=$(cd "$(dirname "$0")" && pwd); cd "$root" || exit 1
[[ -f hackathon.conf ]] && . ./hackathon.conf
base=${BASE_BRANCH:-master}

say()  { printf '[task] %s\n' "$*"; }
die()  { printf '[task] ✘ %s\n' "$*" >&2; exit 1; }
cur_branch() { git rev-parse --abbrev-ref HEAD; }

# 從分支名取 part / nn / short;不在任務分支就停
parse_branch() {
  br=$(cur_branch)
  [[ "$br" =~ ^(shop|control|console)/([0-9][0-9])-([A-Za-z0-9._-]+)$ ]] \
    || die "現在在 $br,不是任務分支;先 bash task.sh start <NN>"
  part=${BASH_REMATCH[1]}; nn=${BASH_REMATCH[2]}
  taskfile=$(ls "$part"/tasks/"$nn"-*.md 2>/dev/null | head -1)
  title=$( [[ -n "$taskfile" ]] && head -1 "$taskfile" | sed 's/^# *//' || echo "$part $nn" )
  fail="$part/.codex/$nn.fail.md"
  mkdir -p "$part/.codex"
}

# PR 狀態:OPEN / MERGED / CLOSED / NONE;gh 本身出錯就停
pr_state() {
  local out; out=$(gh pr view "$1" --json state -q .state 2>&1) && { echo "$out"; return; }
  [[ "$out" == *"no pull requests found"* ]] && { echo NONE; return; }
  die "gh 出錯:$out"
}

# 寫失敗檔(第一行是種類,codex 的 skill 靠它分路)並停。不要放在 pipeline 尾端,那樣 exit 只會結束子 shell
fail_with() {  # $1 種類  $2 給人看的下一步  $3 內容
  printf 'task.sh submit 失敗:%s\n\n%s\n' "$1" "$3" > "$fail"
  say "失敗原因寫在 $fail"
  die "$1。$2"
}

# ---------- start ----------
cmd_start() {
  local nn=${1:-}; local part=${2:-${PART:-}}
  [[ "$nn" =~ ^[0-9][0-9]$ ]] || die "用法:bash task.sh start <NN> [shop|control|console],NN 兩位數"
  [[ -n "$part" ]] || die "不知道你的部份:bash task.sh start $nn shop,或在 hackathon.conf 寫 PART=shop"
  [[ "$part" =~ ^(shop|control|console)$ ]] || die "部份只能是 shop / control / console"
  local taskfile; taskfile=$(ls "$part"/tasks/"$nn"-*.md 2>/dev/null | head -1)
  [[ -n "$taskfile" ]] || die "沒有任務檔 $part/tasks/$nn-*.md"
  local short; short=$(basename "$taskfile" .md); short=${short#"$nn"-}
  local new="$part/$nn-$short"
  [[ -z "$(git status --porcelain)" ]] || die "工作區有未 commit 的改動(git status);要交就 bash task.sh submit,要丟就 git stash"

  local old; old=$(cur_branch); local drop=""
  if [[ "$old" != "$base" ]]; then
    case $(pr_state "$old") in
      MERGED) drop=$old ;;
      OPEN)   die "上一段 $old 的 PR 還沒合併;等 leader。要回去改:git switch $old" ;;
      *)      die "$old 沒有 PR;要交就 bash task.sh submit,要丟就 git switch $base && git branch -D $old" ;;
    esac
  fi
  git switch -q "$base" && git pull -q || die "拉 $base 失敗,看上面 git 的輸出"
  [[ -n "$drop" ]] && { git branch -q -D "$drop"; say "刪掉已合併的 $drop"; }
  git show-ref --verify -q "refs/heads/$new" && die "分支 $new 已存在;合併過的不能再用,git branch -D $new 之後再來"
  git switch -q -c "$new" || die "開分支失敗"
  say "在 $new:$(head -1 "$taskfile" | sed 's/^# *//')"
  say "下一步:bash run-task.sh $part $nn;做完 bash task.sh submit"
}

# ---------- submit ----------
cmd_submit() {
  parse_branch
  gh auth status >/dev/null 2>&1 || die "gh 沒登入:gh auth login"
  rm -f "$fail"
  local state old="" n=1; state=$(pr_state "$br")
  [[ "$state" == MERGED ]] && die "$br 已經合併了;下一段:bash task.sh start <NN>"
  # 第幾輪:看 PR 內文已經有幾個「## 第 N 輪」;同一輪內 submit 幾次都算同一輪
  if [[ "$state" == OPEN ]]; then
    old=$(gh pr view "$br" --json body -q .body | sed '1{/^<!-- nightwatch /d;}')
    n=$(( $(printf '%s' "$old" | grep -c '^## 第 .* 輪') + 1 ))
  fi
  local tag=""; ((n>1)) && tag="(第${n}輪)"

  # 0. 上次 merge 衝突、codex 解完了 → 接著走
  if [[ -f .git/MERGE_HEAD ]]; then
    local marked; marked=$(grep -rlE '^(<{7}|={7}|>{7}|\|{7})' "$part" --exclude-dir=node_modules --exclude-dir=.codex 2>/dev/null || true)
    [[ -z "$marked" ]] || fail_with "merge 衝突" "bash task.sh fix 讓 codex 解,再 bash task.sh submit" "$(printf '衝突標記還在:\n%s' "$marked")"
    git add -A "$part"
    git commit -q --no-edit || die "merge 收尾 commit 失敗;git status 看一下"
    say "merge 衝突解完,接著走"
  fi

  # 1. 越界:不在 $part/ 底下的改動,還原到 master 的版本,內容備份到 .codex/outside/
  local outside; outside=$(git status --porcelain | sed 's/^.. //; s/.* -> //' | grep -v "^$part/" || true)
  local note=""
  if [[ -n "$outside" ]]; then
    local p bak="$part/.codex/outside"; mkdir -p "$bak"
    while IFS= read -r p; do
      [[ -e "$p" ]] && { mkdir -p "$bak/$(dirname "$p")"; cp -R "$p" "$bak/$p"; }
      if git ls-files --error-unmatch "$p" >/dev/null 2>&1; then git checkout -q -- "$p"; else rm -rf "$p"; fi
    done <<<"$outside"
    note=$(printf '越界還原(內容備份在 %s):\n%s' "$bak" "$outside")
    say "$note"
  fi

  # 2. commit(只加自己的目錄)
  git add -A "$part"
  git fetch -q origin "$base" || die "fetch 失敗;網路?"
  if ! git diff --cached --quiet; then
    git commit -q -m "$title$tag" || die "commit 失敗"
    say "commit:$title$tag"
  fi

  # 3. 把最新 master 併進來(才會對著現在的 contracts 做事)。用 merge 不用 rebase:衝突只解一次、不改歷史、不用 force push
  git merge -q --no-edit "origin/$base" >/dev/null 2>&1 || merge_failed

  # 沒新東西、PR 也開著 → 不用重跑
  if [[ "$state" == OPEN && "$(git rev-parse HEAD)" == "$(git rev-parse "origin/$br" 2>/dev/null)" ]]; then
    say "沒有新的改動,PR 還是:$(gh pr view "$br" --json url -q .url)"; return 0
  fi

  # 4. 驗收(選用):要有 CHECK_CMD 而且那個檔在,才跑。不假設每台機器的環境一樣。
  local t0=$SECONDS secs=0 clog="$part/.codex/$nn.check.log"
  local check_script="${CHECK_CMD##* }"
  if [[ -n "${CHECK_CMD:-}" && -f "$check_script" ]]; then
    $CHECK_CMD "$part" 2>&1 | tee "$clog"
    if [[ ${PIPESTATUS[0]} -ne 0 ]]; then
      fail_with "驗收紅" "bash task.sh fix 讓 codex 修,再 bash task.sh submit" \
        "$( { grep '✘' "$clog"; printf '\n--- 驗收輸出最後 60 行 ---\n'; tail -60 "$clog"; } )"
    fi
    secs=$((SECONDS-t0))
  else
    say "沒有驗收指令,跳過(交出去前自己跑過就好)"
  fi
  # 驗收可能動到 lockfile 之類;併進這輪
  git add -A "$part"; git diff --cached --quiet || git commit -q -m "$title$tag(驗收產物)"

  # 5. push(主線由 pre-push 擋)
  git push -q -u origin "$br" || die "push 失敗,看上面 git 的輸出"

  # 6. PR:沒有就開,有就更新內文
  local files; files=$(git diff --name-only "origin/$base...HEAD" | grep -vc '/\.codex/')
  local header="<!-- nightwatch part=$part nn=$nn check=pass secs=$secs files=$files -->"
  local report="$part/.codex/$nn.last.md"; [[ -f "$report" ]] || report=""
  local body="$part/.codex/$nn.pr.md"
  {
    echo "$header"; echo
    [[ -n "$old" ]] && { printf '%s\n\n---\n' "$old"; }
    echo "## 第 $n 輪"; echo
    [[ -n "$note" ]] && { echo "$note"; echo; }
    [[ -n "$report" ]] && cat "$report" || echo "(沒有 codex 回報:$part/.codex/$nn.last.md 不存在)"
  } > "$body"
  local url
  if [[ "$state" == OPEN ]]; then
    gh pr edit "$br" --body-file "$body" >/dev/null || die "更新 PR 內文失敗"
    url=$(gh pr view "$br" --json url -q .url)
    say "PR 已更新(第 $n 輪):$url"
  else
    url=$(gh pr create --base "$base" --head "$br" --title "$title" --body-file "$body" --label "part:$part" 2>/dev/null) \
      || url=$(gh pr create --base "$base" --head "$br" --title "$title" --body-file "$body") \
      || die "開 PR 失敗"
    say "PR 開好了:$url"
  fi
  say "告訴 leader:$title $url"
}

merge_failed() {
  local conflicted; conflicted=$(git diff --name-only --diff-filter=U)
  if [[ -z "$conflicted" ]]; then
    git merge --abort 2>/dev/null; die "merge 失敗但沒有衝突檔;git status 看一下,或找 leader"
  fi
  if printf '%s\n' "$conflicted" | grep -qv "^$part/"; then
    git merge --abort
    fail_with "merge 衝突(不在你的目錄)" "找 leader" "$(printf '衝突的檔案不在你的目錄,已 abort:\n%s' "$conflicted")"
  fi
  fail_with "merge 衝突" "bash task.sh fix 讓 codex 解,再 bash task.sh submit" \
    "$(printf '這些檔案有衝突標記(<<<<<<< HEAD 到 ======= 是這段任務的版本,======= 到 >>>>>>> origin/%s 是 master 上 leader 合進去的版本;中間若有 ||||||| 段是共同祖先,整段拿掉):\n%s' "$base" "$conflicted")"
}

# ---------- fix ----------
cmd_fix() {
  parse_branch
  [[ -f "$fail" ]] || die "沒有失敗紀錄($fail);上一次 submit 沒失敗,或還沒 submit"
  say "把失敗餵給 codex:$(head -1 "$fail")"
  bash run-task.sh "$part" "$nn" "$(cat "$fail")"
  say "修完了就 bash task.sh submit"
}

# ---------- done ----------
cmd_done() {
  local old; old=$(cur_branch)
  [[ "$old" != "$base" ]] || { say "已經在 $base,沒事做"; return; }
  [[ $(pr_state "$old") == MERGED ]] || die "$old 的 PR 還沒合併,不刪"
  [[ -z "$(git status --porcelain)" ]] || die "工作區有未 commit 的改動,先處理"
  git switch -q "$base" && git pull -q && git branch -q -D "$old" || die "收尾失敗,看上面 git 的輸出"
  say "回到 $base,刪掉 ${old}。下一段:bash task.sh start <NN>"
}

case ${1:-} in
  start)  shift; cmd_start "$@" ;;
  submit) cmd_submit ;;
  fix)    cmd_fix ;;
  done)   cmd_done ;;
  *) sed -n '2,11p' "$0"; exit 2 ;;
esac
