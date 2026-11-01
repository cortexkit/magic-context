#!/usr/bin/env bash
# Sourced by independent preflight groups: one failure must not hide the next check.
status=0
check() {
  local label="$1"
  shift
  if ( "$@" ); then
    printf 'PASS %s\n' "$label"
  else
    local result=$?
    printf 'FAIL %s (exit %s)\n' "$label" "$result" >&2
    status=1
  fi
}
