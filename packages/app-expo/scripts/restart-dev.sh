#!/usr/bin/env bash
# ReadAny 移动端开发环境重启脚本
# 用法: bash restart-dev.sh [--clear]
#
# 解决的问题:
#  Windows 上 Metro 没有 watchman 时用 fs.watch,漏文件事件 → 改代码 "进不去"
#  (bundle 保持旧代码,出现 UnableToResolveError / setXxx is not a function)。
#  已安装 watchman(via winget,Path 未刷新),Metro 启动时必须把其 bin 放进 PATH。
#
# 每次会话只需: bash restart-dev.sh
#  - 杀旧 Metro → 以 watchman PATH 重启 Metro(可选 --clear)
#  - 重设 adb reverse + 重启 RA-Debug App

set -e

WATCHMAN_BIN="/c/Users/Voldemort/AppData/Local/Microsoft/WinGet/Packages/facebook.watchman_Microsoft.Winget.Source_8wekyb3d8bbwe/watchman-v2025.02.24.00-windows/bin"
export PATH="$WATCHMAN_BIN:$PATH"

# Sanity: watchman reachable?
if ! watchman version >/dev/null 2>&1; then
  echo "WARN: watchman not reachable at $WATCHMAN_BIN — Metro will fall back to fs.watch (code changes may not hot-reload)."
fi

APP_DIR="/d/MCU/7-Claude code/Project/ReadAny/readany-src/packages/app-expo"
DEVICE="adb-3430047082003V2-E4wJpC (2)._adb-tls-connect._tcp"  # 无线调试 serial;变了就改这里
PKG="com.readany.app.dev.debug"

echo "==> Killing old Metro (node on :8081)..."
powershell -Command "Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id \$_ -Force -ErrorAction SilentlyContinue }" 2>/dev/null || true
# Also catch expo cli processes by command line
powershell -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -match 'expo start' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>/dev/null || true
sleep 3
# Verify port free, else raise
if netstat -ano | grep ":8081" | grep -q "LISTENING"; then
  echo "ERROR: :8081 still in use — kill it manually first."; exit 1
fi

echo "==> Starting Metro with watchman..."
cd "$APP_DIR"
FLAG=""
if [[ "${1:-}" == "--clear" ]]; then FLAG="--clear"; fi
(nohup npx expo start --port 8081 $FLAG > /tmp/metro-dev.log 2>&1 &)
# Startup can take 30-60s on first run (watchman index/cache cold); poll up to 90s.
sleep 8
for i in $(seq 1 22); do
  if netstat -ano | grep ":8081" | grep -q "LISTENING"; then break; fi
  sleep 4
done

echo "==> Verifying Metro on :8081..."
if netstat -ano | grep ":8081" | grep -q "LISTENING"; then
  echo "OK: Metro listening on 8081"
else
  echo "ERROR: Metro did not start — log:"; tail -25 /tmp/metro-dev.log; exit 1
fi

echo "==> Verifying watchman is monitoring roots..."
watchman watch-list 2>&1 | grep -q "readany-src" && echo "OK: watchman active" || echo "WARN: watchman not monitoring — fs.watch fallback (hot reload may miss changes)"

echo "==> Re-set adb reverse + restart $PKG..."
adb -s "$DEVICE" reverse tcp:8081 tcp:8081
adb -s "$DEVICE" shell am force-stop "$PKG" 2>/dev/null || true
sleep 1
adb -s "$DEVICE" shell am start -n "$PKG/com.readany.app.dev.MainActivity" >/dev/null

echo "==> Done. Watch logs: tail -f /tmp/metro-dev.log"
echo "    First bundle after --clear takes 1-2 min."
