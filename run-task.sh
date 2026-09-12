#!/usr/bin/env bash
# 用法:bash run-task.sh <shop|control|console> <NN> [額外一句話]
#   環境變數:CODEX_MODEL(預設 gpt-5.6-luna)、CODEX_EFFORT(xhigh)、CODEX_TIER(fast)、PART_DIR(換目錄跑)
#   例:bash run-task.sh shop 01
#       bash run-task.sh control 02 "上一輪沒過驗收:/api/graph 的 nodes 是空的,請修"
#
# 在該部份的資料夾裡以「codex gpt-5.6-luna / xhigh / fast」跑一段任務。
# 任務檔 = <part>/tasks/<NN>-*.md;codex 的完整輸出存 <part>/.codex/<NN>.log,
# 最後一則回報存 <part>/.codex/<NN>.last.md(給合併的人看)。
set -uo pipefail
part=${1:?part}; nn=${2:?NN}; extra=${3:-}
root=$(cd "$(dirname "$0")" && pwd)
dir="${PART_DIR:-$root/$part}"          # PART_DIR:在別的目錄跑(試不同模型時用)
model=${CODEX_MODEL:-gpt-5.6-luna}; effort=${CODEX_EFFORT:-xhigh}; tier=${CODEX_TIER:-fast}
task=$(ls "$dir"/tasks/"$nn"-*.md 2>/dev/null | head -1)
[[ -n "$task" ]] || { echo "找不到任務檔 $dir/tasks/$nn-*.md" >&2; exit 2; }
mkdir -p "$dir/.codex"

prompt=$(cat <<PROMPT
你在 $dir 這個目錄工作,這是 hackathon 的「${part}」部份。下面有你這塊的說明與這一段的任務。
$( [[ "$part" == deploy ]] && echo "只改這個目錄底下的檔案;../contracts 與 ../stubs 唯讀;可以讀 ../shop ../control ../console 來編映像但不要改它們。" || echo "只改這個目錄底下的檔案;../contracts 與 ../stubs 唯讀;其他部份的目錄不要讀,鄰居的介面只看 ../contracts。" )
你可以自己起服務、curl、跑測試來驗收(沙箱允許綁 port 與連網)。
做完照 AGENTS.md 的回報格式寫:做了什麼、依據什麼驗證的、沒有驗證的、契約疑問。
${extra:+補充:$extra}

===== 你這塊是什麼(BRIEF.md) =====
$( [[ -f "$dir/BRIEF.md" ]] && cat "$dir/BRIEF.md" || echo "(這個部份還沒有 BRIEF.md)" )

===== 這一段的任務 =====
$(cat "$task")
PROMPT
)

echo "[run-task] $part $nn → $(basename "$task")  model=$model/$effort/$tier  log: $dir/.codex/$nn.log"
started=$SECONDS
codex exec --cd "$dir" \
  -m "$model" \
  -c model_reasoning_effort="\"$effort\"" \
  -c service_tier="\"$tier\"" \
  -s workspace-write \
  -c sandbox_workspace_write.network_access=true \
  -c approval_policy='"never"' \
  --color never \
  -o "$dir/.codex/$nn.last.md" \
  - <<<"$prompt" 2>&1 | tee "$dir/.codex/$nn.log"
status=${PIPESTATUS[0]}
echo "[run-task] $part $nn 結束 exit=$status 耗時 $((SECONDS-started))s;回報在 $dir/.codex/$nn.last.md"
exit "$status"
