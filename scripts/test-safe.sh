#!/usr/bin/env bash
# Сторож считает суммарный RSS только собственной process group.
# Боевой DATABASE_URL не наследуется процессами тестов.
set -uo pipefail
limit_mb="${NODE_TEST_MAX_RSS_MB:-2048}"
if ! [[ "$limit_mb" =~ ^[1-9][0-9]*$ ]]; then exit 2; fi
setsid env -u DATABASE_URL NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 "$@" &
test_pid=$!
stop_group() {
  kill -TERM -- "-$test_pid" 2>/dev/null || true
  sleep 1
  kill -KILL -- "-$test_pid" 2>/dev/null || true
}
trap stop_group INT TERM HUP
peak_kb=0
while kill -0 "$test_pid" 2>/dev/null; do
  rss_kb=$(ps -eo pgid=,rss= | awk -v id="$test_pid" '$1 == id {sum += $2} END {print sum+0}')
  if (( rss_kb > peak_kb )); then peak_kb=$rss_kb; fi
  if (( rss_kb > limit_mb * 1024 )); then
    stop_group
    wait "$test_pid" 2>/dev/null || true
    echo "watchdog: memory limit exceeded, peak=${peak_kb}KB" >&2
    exit 137
  fi
  sleep 0.25
done
wait "$test_pid"
status=$?
echo "watchdog: peak=${peak_kb}KB exit=$status" >&2
exit "$status"
