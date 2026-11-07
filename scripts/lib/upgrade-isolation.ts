import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** Give every subprocess a private home, including paths used by host config loaders. */
export function isolatedEnvironment(root: string, storage: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: join(root, "home"),
        TMPDIR: root,
        XDG_DATA_HOME: join(root, "data"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_RUNTIME_DIR: join(root, "runtime"),
        OPENCODE_DB: join(root, "opencode.db"),
        MAGIC_CONTEXT_STORAGE_DIR: storage,
        MAGIC_CONTEXT_TEST_DATA_DIR: "",
        MAGIC_CONTEXT_LOG_PATH: join(root, "rehearsal.log"),
        NODE_ENV: "production",
    };
    for (const key of [
        "SUBC_MODULE_ID",
        "SUBC_LAUNCH_NONCE",
        "SUBC_LAUNCH_NONCE_FD",
        "OPENCODE_CONFIG",
        "OPENCODE_CONFIG_DIR",
        "OPENCODE_CONFIG_CONTENT",
        "MC_E2E_KEEP",
        "MC_E2E_MODE",
        "MC_E2E_PLUGIN_ENTRY",
        "MC_E2E_PI_PLUGIN_ROOT",
        "MAGIC_CONTEXT_DB",
        "MAGIC_CONTEXT_MODE3_STORE",
    ])
        delete env[key];
    for (const key of [
        "HOME",
        "TMPDIR",
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "XDG_STATE_HOME",
        "XDG_CACHE_HOME",
        "XDG_RUNTIME_DIR",
        "MAGIC_CONTEXT_STORAGE_DIR",
    ])
        mkdirSync(env[key]!, { recursive: true, mode: 0o700 });
    return env;
}
