#!/usr/bin/env bash
# The Tauri command for the Linux legs of .github/workflows/dashboard-release.yml.
#
# tauri-action runs `bash ../../scripts/dashboard-appimage-build.sh build <args>`
# from packages/dashboard (its `tauriScript` input). This runs the same
# `bunx tauri` the other legs use, and after a build it removes the bundled
# libwayland from the AppImage, repacks and re-signs it
# (dashboard-appimage-drop-wayland.sh), then verifies the result
# (dashboard-appimage-verify.sh). All of that happens before this script
# returns, and tauri-action only then uploads the AppImage and its .sig and
# writes the latest.json entry from that .sig, so the release never carries the
# original AppImage or a signature made over it.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
dashboard_dir="$repo_root/packages/dashboard"

cd "$dashboard_dir"
bunx tauri "$@"

if [[ "${1:-}" != "build" ]]; then
  exit 0
fi

target=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[i]}" in
    --target) target="${args[i + 1]:-}" ;;
    --target=*) target="${args[i]#--target=}" ;;
  esac
done

target_dir="${CARGO_TARGET_DIR:-$dashboard_dir/src-tauri/target}"
bundle_dir="$target_dir/${target:+$target/}release/bundle/appimage"

# Tauri empties bundle/appimage at the start of every AppImage bundle, so this
# build's AppImage is the only one there.
shopt -s nullglob
appimages=("$bundle_dir"/*.AppImage)
shopt -u nullglob
if [[ ${#appimages[@]} -ne 1 ]]; then
  echo "error: expected exactly one AppImage in $bundle_dir, found ${#appimages[@]}" >&2
  exit 1
fi

bash "$repo_root/scripts/dashboard-appimage-drop-wayland.sh" "${appimages[0]}"
bash "$repo_root/scripts/dashboard-appimage-verify.sh" "${appimages[0]}"
