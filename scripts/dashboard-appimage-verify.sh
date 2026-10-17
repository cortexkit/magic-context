#!/usr/bin/env bash
# Release gate for the dashboard's Linux AppImage. Fails unless all hold:
#   1. the extracted AppImage (--appimage-extract) contains no libwayland-* file;
#   2. `ldd` on the extracted main binary, with the AppImage's own library
#      directories first on LD_LIBRARY_PATH the way its AppRun sets them up,
#      resolves every libwayland library to a file outside the AppImage, i.e.
#      the system's copy;
#   3. <AppImage>.sig verifies the AppImage against the updater public key in
#      packages/dashboard/src-tauri/tauri.conf.json, using the CLI installer's
#      own verifier (scripts/dashboard-updater-verify.ts).
#
# Usage: scripts/dashboard-appimage-verify.sh <path/to/App.AppImage>
#
# The host must have libwayland installed (the release runners do, through the
# WebKitGTK build dependencies); otherwise check 2 cannot resolve it and fails.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <path/to/App.AppImage>" >&2
  exit 2
fi

appimage="$(realpath "$1")"
signature="$appimage.sig"
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
failed=0

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
(cd "$work" && "$appimage" --appimage-extract >/dev/null)
appdir="$work/squashfs-root"

# 1. No bundled libwayland.
mapfile -t bundled < <(cd "$appdir" && find . -name 'libwayland-*' | sort)
if [[ ${#bundled[@]} -gt 0 ]]; then
  echo "FAIL: the AppImage bundles libwayland:" >&2
  printf '  %s\n' "${bundled[@]#./}" >&2
  failed=1
else
  echo "ok: no libwayland-* file in the extracted AppImage"
fi

# 2. ldd resolves libwayland from the system. The main binary is the Exec= of
# the desktop file at the AppDir root.
desktop="$(find "$appdir" -maxdepth 1 -name '*.desktop' | head -n 1)"
exec_name="$(sed -n 's/^Exec=\([^ ]*\).*/\1/p' "$desktop" | head -n 1)"
binary="$appdir/usr/bin/$exec_name"
if [[ -z "$exec_name" || ! -f "$binary" ]]; then
  echo "FAIL: cannot find the main binary (desktop file: ${desktop:-none}, Exec=${exec_name:-none})" >&2
  failed=1
else
  # Every AppDir directory that holds shared libraries, as AppRun would put them first.
  lib_path="$(cd "$appdir" && find . -name '*.so*' -printf '%h\n' | sort -u | sed "s|^\.|$appdir|" | paste -sd: -)"
  ldd_out="$(LD_LIBRARY_PATH="$lib_path${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" ldd "$binary" || true)"
  wayland_lines="$(grep -E '^[[:space:]]*libwayland-' <<<"$ldd_out" || true)"
  if [[ -z "$wayland_lines" ]]; then
    # Without a libwayland line the check below would pass without testing anything.
    echo "FAIL: ldd shows no libwayland dependency for $exec_name, so the system copy cannot be confirmed" >&2
    failed=1
  else
    echo "ldd $exec_name (libwayland lines):"
    while read -r line; do echo "  $line"; done <<<"$wayland_lines"
    if grep -qE 'not found' <<<"$wayland_lines"; then
      echo "FAIL: libwayland is not found on this system" >&2
      failed=1
    elif grep -qF "$appdir" <<<"$wayland_lines"; then
      echo "FAIL: libwayland still resolves from inside the AppImage" >&2
      failed=1
    else
      echo "ok: libwayland resolves from the system"
    fi
  fi
fi

# 3. The updater signature matches this exact file.
if [[ ! -s "$signature" ]]; then
  echo "FAIL: no signature at $signature" >&2
  failed=1
elif ! bun "$repo_root/scripts/dashboard-updater-verify.ts" "$appimage" "$signature"; then
  failed=1
fi

if [[ $failed -ne 0 ]]; then
  echo "AppImage verification failed: $appimage" >&2
  exit 1
fi
echo "AppImage verification passed: $appimage"
