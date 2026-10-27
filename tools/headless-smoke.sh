#!/usr/bin/env bash
# Headless smoke test for oneko-wayland.
# Brings up a private, headless gnome-shell (its own session bus AND an
# isolated XDG_STATE_HOME, so it can neither see nor overwrite your real saved
# cats), spawns a trio in the given mode, lets them tick, and fails if the
# extension logged a JS error or if the cats never actually spawned.
#
# Usage: headless-smoke.sh [mode] [tick_seconds]
set -uo pipefail

MODE="${1:-prowl}"
TICK_SECONDS="${2:-8}"
CLI="$HOME/.local/bin/oneko-wayland"
LOG="$(mktemp)"
STATE_DIR="$(mktemp -d)"   # isolate saved-cat state; real cats untouched

dbus-run-session -- env XDG_STATE_HOME="$STATE_DIR" CANBERRA_DRIVER=null bash -c '
  set -uo pipefail
  gnome-shell --headless --virtual-monitor 1920x1080 &
  SHELL_PID=$!

  for i in $(seq 1 50); do
    if gdbus introspect --session --dest org.oneko.Wayland \
         --object-path /org/oneko/Wayland >/dev/null 2>&1; then break; fi
    sleep 0.5
  done

  "'"$CLI"'" add SmokeA --speed 16 --offset=35  --time 100000 --mode '"$MODE"'
  "'"$CLI"'" add SmokeB --speed 16 --offset=-35 --time 100200 --mode '"$MODE"'
  "'"$CLI"'" add SmokeC --speed 16 --offset=0   --time 100400 --mode '"$MODE"'

  sleep '"$TICK_SECONDS"'

  kill "$SHELL_PID" 2>/dev/null; wait "$SHELL_PID" 2>/dev/null
' >"$LOG" 2>&1

spawned=$(grep -c "is on the prowl" "$LOG")
echo "cats spawned: $spawned"

fail=0
if [ "$spawned" -lt 3 ]; then
  echo "FAIL: expected 3 cats to spawn, got $spawned"
  grep -iE "error|invalid choice" "$LOG" | grep -vi "evolution\|portal\|vfs\|calendar\|secret" | head
  fail=1
fi
if grep -E "JS ERROR" "$LOG" | grep -Ei "oneko|disco-chef|cat\.js|extension\.js" >/dev/null; then
  echo "FAIL: JS error from the extension:"
  grep -E "JS ERROR" "$LOG" | grep -Ei "oneko|disco-chef|cat\.js|extension\.js"
  fail=1
fi

[ "$fail" = 0 ] && echo "OK: 3 cats ticked for ${TICK_SECONDS}s in '${MODE}' mode with no extension JS errors"
rm -rf "$LOG" "$STATE_DIR"
exit "$fail"
