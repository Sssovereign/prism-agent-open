#!/usr/bin/env bash
# 兼容旧入口；所有安装包统一走 Electron 桌面发布链。
set -euo pipefail
cd -- "$(dirname -- "$0")/../.."
exec node scripts/installer/build-desktop.mjs "$@"
