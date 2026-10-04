// ../plugin/src/shared/harness.ts
var currentHarness = "opencode";
var harnessLocked = false;
function setHarness(value) {
  if (harnessLocked && currentHarness !== value) {
    throw new Error(`Magic Context: harness already locked to "${currentHarness}"; cannot change to "${value}"`);
  }
  currentHarness = value;
  harnessLocked = true;
}
function getHarness() {
  return currentHarness;
}
function harnessOwnsOpenCodeStore(harness = currentHarness) {
  return harness === "opencode" || harness === "opencode2";
}

// ../plugin/src/shared/data-path.ts
import * as os from "node:os";
import * as path from "node:path";

// ../plugin/src/shared/test-temp-dir.ts
var STALE_TEMP_DIR_AGE_MS = 60 * 60 * 1000;
var registeredTempDirs = new Set;

// ../plugin/src/shared/data-path.ts
function getDataDir() {
  return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
}
function getMagicContextTempDir(harness = getHarness()) {
  return path.join(os.tmpdir(), harness, "magic-context");
}
function getMagicContextLogPath(harness = getHarness()) {
  const envPath = process.env.MAGIC_CONTEXT_LOG_PATH?.trim();
  if (envPath)
    return envPath;
  return path.join(getMagicContextTempDir(harness), "magic-context.log");
}
function getOpenCodeStorageDir() {
  return path.join(getDataDir(), "opencode", "storage");
}
function getMagicContextStorageResolution() {
  const testDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR?.trim();
  if (testDataDir) {
    const perTestDataHome = process.env.XDG_DATA_HOME?.trim();
    if (perTestDataHome && path.resolve(perTestDataHome) !== path.resolve(testDataDir)) {
      return {
        path: path.join(perTestDataHome, "cortexkit", "magic-context"),
        source: "test isolation"
      };
    }
    return {
      path: path.join(testDataDir, "cortexkit", "magic-context"),
      source: "test isolation"
    };
  }
  if (false) {}
  const explicitStorageDir = process.env.MAGIC_CONTEXT_STORAGE_DIR?.trim();
  if (explicitStorageDir) {
    if (!path.isAbsolute(explicitStorageDir)) {
      throw new Error("MAGIC_CONTEXT_STORAGE_DIR must be an absolute path");
    }
    return { path: explicitStorageDir, source: "environment override" };
  }
  const xdgDataHome = process.env.XDG_DATA_HOME?.trim();
  if (xdgDataHome) {
    return {
      path: path.join(xdgDataHome, "cortexkit", "magic-context"),
      source: "XDG_DATA_HOME"
    };
  }
  return {
    path: path.join(os.homedir(), ".local", "share", "cortexkit", "magic-context"),
    source: "platform default"
  };
}
function getMagicContextStorageDir() {
  return getMagicContextStorageResolution().path;
}
function getLegacyOpenCodeMagicContextStorageDir() {
  return path.join(getOpenCodeStorageDir(), "plugin", "magic-context");
}

export { setHarness, getHarness, harnessOwnsOpenCodeStore, getDataDir, getMagicContextTempDir, getMagicContextLogPath, getMagicContextStorageDir, getLegacyOpenCodeMagicContextStorageDir };
