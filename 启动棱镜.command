#!/usr/bin/env bash
set -euo pipefail
if [[ -d /Applications/Prism.app ]]; then
  exec open /Applications/Prism.app
fi
osascript -e 'display alert "尚未安装棱镜桌面版" message "请打开 releases 中的 Prism dmg，将 Prism 拖入 Applications 后启动。"'
