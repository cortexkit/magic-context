import * as os from "node:os";
import * as path from "node:path";

export function getDataDir(): string {
    return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
}

export function getOpenCodeStorageDir(): string {
    return path.join(getDataDir(), "opencode", "storage");
}
