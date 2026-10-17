#!/usr/bin/env bash
# Remove the bundled libwayland libraries from a Tauri-built dashboard AppImage,
# repack it, and re-sign it for the updater.
#
# Usage: scripts/dashboard-appimage-drop-wayland.sh <path/to/App.AppImage>
#
# Why: the AppImage's AppRun puts its bundled libraries ahead of the system's.
# Mesa is not bundled, so the host's Mesa EGL ends up loading the bundled
# libwayland. On hosts whose Mesa was built against a newer libwayland (1.23
# and later) EGL display creation fails with EGL_BAD_ALLOC and the window never
# appears. libwayland must come from the host, next to the Mesa that uses it;
# the AppImage community excludelist (AppImageCommunity/pkg2appimage) lists
# libwayland-client.so.0 for this reason.
#
# Tauri offers no way to exclude a library: its AppImage config has only
# `bundleMediaFramework` and `files`, and the linuxdeploy build it downloads
# predates linuxdeploy's LINUXDEPLOY_EXCLUDED_LIBRARIES variable. So the files
# are removed after the bundle step instead:
#   1. extract the AppImage (--appimage-extract) and its runtime (the bytes
#      before the squashfs image, --appimage-offset);
#   2. delete every libwayland-* file from the AppDir;
#   3. repack with the linuxdeploy-plugin-appimage that Tauri downloaded into
#      its tool cache and used for the original, passing the original runtime
#      (LDAI_RUNTIME_FILE) so only the AppDir contents change;
#   4. sign the repacked file with `tauri signer sign` and the release key from
#      TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD.
# The signature Tauri wrote for the original file is deleted first, so a
# failure at any step leaves no signature that belongs to a different file.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <path/to/App.AppImage>" >&2
  exit 2
fi

appimage="$(realpath "$1")"
signature="$appimage.sig"
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
dashboard_dir="$repo_root/packages/dashboard"

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  echo "error: TAURI_SIGNING_PRIVATE_KEY is not set; the repacked AppImage cannot be signed" >&2
  exit 1
fi

# Tauri keeps its AppImage tools in dirs::cache_dir()/tauri, which on Linux is
# $XDG_CACHE_HOME/tauri or ~/.cache/tauri.
tools_dir="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"
plugin="$tools_dir/linuxdeploy-plugin-appimage.AppImage"
if [[ ! -x "$plugin" ]]; then
  # Tauri falls back to linuxdeploy's built-in packer when this download fails.
  # Packing with a different tool than the original would not be a like-for-like
  # repack, so stop here; rerunning the release downloads it again.
  echo "error: $plugin is missing; Tauri did not download linuxdeploy-plugin-appimage in this build" >&2
  exit 1
fi

rm -f "$signature"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

offset="$("$appimage" --appimage-offset)"
head -c "$offset" "$appimage" >"$work/runtime"
(cd "$work" && "$appimage" --appimage-extract >/dev/null)
appdir="$work/squashfs-root"

mapfile -t bundled < <(cd "$appdir" && find . -name 'libwayland-*' \( -type f -o -type l \) | sort)
if [[ ${#bundled[@]} -eq 0 ]]; then
  echo "note: $appimage bundles no libwayland-* files; repacking and re-signing anyway"
fi
for file in "${bundled[@]}"; do
  echo "removing bundled ${file#./}"
  rm -f "$appdir/$file"
done

# The environment Tauri gives linuxdeploy, which hands it to the plugin. Tauri
# passes the output path as OUTPUT, which the plugin reads as a deprecated
# alias of LDAI_OUTPUT.
LDAI_OUTPUT="$work/repacked.AppImage" \
  ARCH="$(uname -m)" \
  APPIMAGE_EXTRACT_AND_RUN=1 \
  LDAI_RUNTIME_FILE="$work/runtime" \
  "$plugin" --appdir "$appdir"

if [[ ! -s "$work/repacked.AppImage" ]]; then
  echo "error: linuxdeploy-plugin-appimage produced no AppImage" >&2
  exit 1
fi
chmod 755 "$work/repacked.AppImage"
mv -f "$work/repacked.AppImage" "$appimage"

# `bunx tauri` from the dashboard package resolves to its pinned @tauri-apps/cli.
(cd "$dashboard_dir" && bunx tauri signer sign "$appimage")
if [[ ! -s "$signature" ]]; then
  echo "error: tauri signer sign wrote no $signature" >&2
  exit 1
fi
echo "repacked and re-signed $appimage"
