#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
set -uo pipefail

# Random unprivileged port
PORT=$((30000 + RANDOM % 30000))
echo "::group::Spawn opencode serve --hostname $HOSTNAME --port $PORT"

# Isolated XDG dirs so the daemon does its first-run SQLite migration
# in a clean state — same as host e2e harness.
WORKDIR=$(mktemp -d)
export XDG_CONFIG_HOME="$WORKDIR/config"
export XDG_DATA_HOME="$WORKDIR/data"
export XDG_CACHE_HOME="$WORKDIR/cache"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"

# The real host must use normal runtime behavior and logging, not its NODE_ENV=test branches.
unset NODE_ENV
export ANTHROPIC_API_KEY="test-key-not-real"

# Tee stdout+stderr to files so we can inspect after probing.
opencode serve --hostname "$HOSTNAME" --port "$PORT" \
  > "$WORKDIR/stdout.log" 2> "$WORKDIR/stderr.log" &
SERVE_PID=$!
echo "opencode serve pid: $SERVE_PID"
echo "::endgroup::"

# Wait up to 30s for opencode to print "listening" — that's the
# signal that Server.listen() returned.
for i in $(seq 1 150); do
  if grep -q "opencode server listening on" "$WORKDIR/stdout.log" 2>/dev/null; then
    break
  fi
  sleep 0.2
done

echo "::group::opencode stdout (post-listen window)"
cat "$WORKDIR/stdout.log"
echo "::endgroup::"
echo "::group::opencode stderr (post-listen window)"
cat "$WORKDIR/stderr.log"
echo "::endgroup::"

if ! grep -q "opencode server listening on" "$WORKDIR/stdout.log"; then
  echo "::error::opencode never printed 'listening on' within 30s — process failed to start"
  kill -TERM "$SERVE_PID" 2>/dev/null || true
  exit 1
fi

# === Probe matrix: try both 127.0.0.1 and (if hostname=0.0.0.0)
# also localhost. Test BOTH curl and bun's fetch independently.
echo "::group::HTTP probes"

CURL_127=0
CURL_LOCALHOST=0
BUN_127=0
BUN_LOCALHOST=0

# curl 127.0.0.1
if curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/doc" > /dev/null 2>&1; then
  CURL_127=1
  echo "  curl http://127.0.0.1:${PORT}/doc → OK"
else
  echo "  curl http://127.0.0.1:${PORT}/doc → FAIL"
fi

# curl localhost (different name resolution path)
if curl -fsS --max-time 5 "http://localhost:${PORT}/doc" > /dev/null 2>&1; then
  CURL_LOCALHOST=1
  echo "  curl http://localhost:${PORT}/doc → OK"
else
  echo "  curl http://localhost:${PORT}/doc → FAIL"
fi

# bun fetch 127.0.0.1
if bun -e "const r = await fetch('http://127.0.0.1:${PORT}/doc'); console.log('status', r.status); if (!r.ok && r.status !== 404 && r.status !== 401) process.exit(1);" 2>&1; then
  BUN_127=1
  echo "  bun fetch http://127.0.0.1:${PORT}/doc → OK"
else
  echo "  bun fetch http://127.0.0.1:${PORT}/doc → FAIL"
fi

# bun fetch localhost
if bun -e "const r = await fetch('http://localhost:${PORT}/doc'); console.log('status', r.status); if (!r.ok && r.status !== 404 && r.status !== 401) process.exit(1);" 2>&1; then
  BUN_LOCALHOST=1
  echo "  bun fetch http://localhost:${PORT}/doc → OK"
else
  echo "  bun fetch http://localhost:${PORT}/doc → FAIL"
fi

echo "::endgroup::"

# Cleanup
kill -TERM "$SERVE_PID" 2>/dev/null || true
sleep 1
kill -KILL "$SERVE_PID" 2>/dev/null || true

# Summary in step output for easy table viewing
echo "## Probe results (hostname=${HOSTNAME})" >> "$GITHUB_STEP_SUMMARY"
echo "" >> "$GITHUB_STEP_SUMMARY"
echo "| probe | result |" >> "$GITHUB_STEP_SUMMARY"
echo "|-------|--------|" >> "$GITHUB_STEP_SUMMARY"
echo "| curl 127.0.0.1 | $( [ "$CURL_127" = 1 ] && echo "✅" || echo "❌" ) |" >> "$GITHUB_STEP_SUMMARY"
echo "| curl localhost | $( [ "$CURL_LOCALHOST" = 1 ] && echo "✅" || echo "❌" ) |" >> "$GITHUB_STEP_SUMMARY"
echo "| bun  127.0.0.1 | $( [ "$BUN_127" = 1 ] && echo "✅" || echo "❌" ) |" >> "$GITHUB_STEP_SUMMARY"
echo "| bun  localhost | $( [ "$BUN_LOCALHOST" = 1 ] && echo "✅" || echo "❌" ) |" >> "$GITHUB_STEP_SUMMARY"

# Fail the step if NEITHER probe reached the server. If curl
# works but fetch fails (or vice versa), surface the asymmetry
# via a clear annotation but DO NOT fail — that's diagnostic
# signal we want to capture, not a green/red gate.
ANY_OK=0
[ "$CURL_127" = 1 ] && ANY_OK=1
[ "$CURL_LOCALHOST" = 1 ] && ANY_OK=1
[ "$BUN_127" = 1 ] && ANY_OK=1
[ "$BUN_LOCALHOST" = 1 ] && ANY_OK=1

if [ "$ANY_OK" = 0 ]; then
  echo "::error::Neither curl nor bun fetch could reach opencode (hostname=$HOSTNAME). This is a real bring-up failure."
  exit 1
fi

if [ "$CURL_127" = 1 ] && [ "$BUN_127" = 0 ]; then
  echo "::warning::curl reaches 127.0.0.1 but bun fetch does not — bun's HTTP client has a Linux loopback edge case."
fi
if [ "$BUN_LOCALHOST" = 1 ] && [ "$BUN_127" = 0 ]; then
  echo "::warning::bun fetch works on 'localhost' but not '127.0.0.1' — bun's name resolution differs from raw IPv4 path."
fi

echo "Probe pass for hostname=$HOSTNAME"
