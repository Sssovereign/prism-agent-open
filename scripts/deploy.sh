#!/usr/bin/env bash
# 棱镜更新执行器（git pull-to-deploy）：GitHub main 为唯一发布源。
# 用法：scripts/deploy.sh --data-dir <正式数据目录> [--skip-health]
# 流程：fetch → SHA对比 → ff合并 → 锁文件变化时安装 → 停旧实例 → 清洁构建 →
#       迁移 → 启动 → 健康门禁。服务进程只做检测提示（/api/v1/update-check），
# 实际更新由本脚本执行——进程不自我更新，构建失败不会留下半更新状态。
# 纪律：工作树必须干净（更新只来自GitHub）；迁移只新增；停机窗口=构建时长（分钟级）。
set -euo pipefail
cd -- "$(dirname -- "$0")/.."

DATA_DIR=""
SKIP_HEALTH=0
FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --skip-health) SKIP_HEALTH=1; shift ;;
    --force) FORCE=1; shift ;;  # 已最新也强制重建重启（重部署/回滚后重建）
    *) echo "未知参数：$1"; exit 2 ;;
  esac
done
if [[ -z "$DATA_DIR" ]]; then
  echo "错误：必须显式指定 --data-dir（正式数据目录，如 /path/to/.data）" >&2
  exit 2
fi

PORT="${DEBATE_PORT:-4391}"

# Node/pnpm 定位：Finder/launchd 环境可能没有完整 PATH
task_runtime_root="${HOME}/.cache/codex-runtimes/codex-primary-runtime/dependencies"
if ! command -v node >/dev/null || ! command -v pnpm >/dev/null; then
  if [[ -x "$task_runtime_root/node/bin/node" && -x "$task_runtime_root/bin/fallback/pnpm" ]]; then
    export PATH="$task_runtime_root/node/bin:$task_runtime_root/bin/fallback:$PATH"
  fi
fi
command -v node >/dev/null || { echo "错误：找不到 node（需 Node 24）" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "错误：找不到 pnpm" >&2; exit 1; }

if [[ -n "$(git status --porcelain)" ]]; then
  echo "错误：工作树不干净，拒绝更新（发布只能来自 GitHub main）：" >&2
  git status --porcelain | head -10 >&2
  exit 1
fi

git fetch origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse FETCH_HEAD)  # FETCH_HEAD 在标签/单分支克隆下也必然存在（origin/main 引用则未必）
if [[ "$LOCAL" == "$REMOTE" && "$FORCE" != "1" ]]; then
  echo "已是最新（${LOCAL}），无需更新。"
  exit 0
fi
if [[ "$LOCAL" == "$REMOTE" ]]; then
  echo "已最新（${LOCAL}），--force 重建重启。"
else
  echo "更新：${LOCAL:0:12} → ${REMOTE:0:12}"
fi
git merge --ff-only FETCH_HEAD

# 锁文件变化才重装依赖（frozen 保证与发布源一致）
if git diff --name-only "${LOCAL}" HEAD -- pnpm-lock.yaml | grep -q .; then
  echo "锁文件变化，重新安装依赖…"
  pnpm install --frozen-lockfile
fi

# 停旧实例：只按端口精确定位，不按进程名批量结束
OLD_PID=""
if command -v lsof >/dev/null; then
  OLD_PID=$(lsof -ti "tcp:${PORT}" -sTCP:LISTEN || true)
fi
if [[ -n "$OLD_PID" ]]; then
  echo "停止旧实例 PID ${OLD_PID}…"
  kill -TERM "$OLD_PID"
  for _ in $(seq 1 30); do
    kill -0 "$OLD_PID" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "错误：旧实例 ${OLD_PID} 未在30秒内退出，中止更新（未改动任何产物）" >&2
    exit 1
  fi
fi

# 清洁构建（避免新旧产物叠加）；tsc 不拷贝 .sql，迁移集合需显式同步
rm -rf dist web-dist
pnpm run build
mkdir -p dist/src/storage/migrations
cp -R src/storage/migrations/. dist/src/storage/migrations/

echo "应用迁移…"
DEBATE_DATA_DIR="$DATA_DIR" node -e "const{Db,defaultDbPath}=await import(String.raw\`./dist/src/storage/db.js\`);const{archiveLegacyMock}=await import(String.raw\`./dist/src/storage/legacy.js\`);const{migrate,defaultMigrationsDir}=await import(String.raw\`./dist/src/storage/migrate.js\`);const db=new Db(defaultDbPath(process.env.DEBATE_DATA_DIR||String.raw\`./.data\`));archiveLegacyMock(db);console.log(migrate(db,defaultMigrationsDir()));db.close()" --input-type=module

echo "启动新实例…"
nohup env DEBATE_DATA_DIR="$DATA_DIR" DEBATE_PORT="$PORT" node dist/src/server.js >> "$DATA_DIR/server.log" 2>&1 &
NEW_PID=$!
disown "$NEW_PID" 2>/dev/null || true
echo "新实例 PID ${NEW_PID}"

if [[ "$SKIP_HEALTH" == "1" ]]; then
  echo "跳过健康检查（--skip-health）。"
  exit 0
fi
for _ in $(seq 1 30); do
  if curl -sf -m 3 "http://127.0.0.1:${PORT}/api/v1/health" | grep -q '"version"'; then
    echo "健康检查通过 ✓  http://127.0.0.1:${PORT}"
    curl -s -m 3 "http://127.0.0.1:${PORT}/api/v1/health"; echo
    exit 0
  fi
  sleep 1
done
echo "错误：健康检查未通过，请查看 $DATA_DIR/server.log" >&2
exit 1
