import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

let pendingUpdate: Update | null = null;

/**
 * Check for updates, download if available.
 * Returns the new version string or null.
 */
export async function checkForUpdate(): Promise<string | null> {
  try {
    const update = await check();
    if (!update) return null;

    // Download in background
    await update.download();
    pendingUpdate = update;
    return update.version;
  } catch {
    return null;
  }
}

/**
 * Install a previously downloaded update and relaunch.
 */
export async function installAndRelaunch(): Promise<void> {
  if (!pendingUpdate) return;
  try {
    await pendingUpdate.install();
    await relaunch();
  } catch (e) {
    console.error("Failed to install update:", e);
  }
}
