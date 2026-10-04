/**
 * Process-level boot for Magic Context under Claude Code.
 *
 * The MCP server and the hook command are separate processes; both open the
 * shared CortexKit database (`context.db`) through the same core the OpenCode and
 * Pi plugins use, as the `claude-code` harness. Opening is lazy: the MCP server
 * must answer `initialize` and `tools/list` even when storage is unavailable, and
 * report the reason when a tool is actually called.
 */

import "./boot-harness";
import { loadPluginConfig, type MagicContextPluginConfig } from "@magic-context/core/config";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
    closeDatabase,
    getDatabasePersistenceError,
    isDatabasePersisted,
    openDatabase,
} from "@magic-context/core/features/magic-context/storage";
import { getErrorMessage } from "@magic-context/core/shared/error-message";
import type { Database } from "@magic-context/core/shared/sqlite";

export interface Runtime {
    db: Database;
    config: MagicContextPluginConfig;
    /** Project directory Claude Code was started in. */
    directory: string;
    /** Stable cross-host project identity, or undefined when none can be resolved. */
    projectPath: string | undefined;
    close: () => void;
}

export class StorageUnavailableError extends Error {
    constructor(reason: string) {
        super(`Magic Context storage is unavailable: ${reason}`);
        this.name = "StorageUnavailableError";
    }
}

/**
 * Open storage and load configuration for one project directory. Throws
 * {@link StorageUnavailableError} when the shared database cannot be used (a
 * newer schema than this build knows, an unwritable path, a failed migration);
 * callers surface the message instead of running without persistence.
 */
export function openRuntime(directory: string): Runtime {
    let db: Database | null;
    try {
        db = openDatabase();
    } catch (error) {
        throw new StorageUnavailableError(getErrorMessage(error));
    }
    if (!db || !isDatabasePersisted(db)) {
        const reason = getDatabasePersistenceError(db);
        throw new StorageUnavailableError(
            reason ??
                "the database was opened by a newer Magic Context than this plugin build; update the plugin",
        );
    }
    const config = loadPluginConfig(directory);
    return {
        db,
        config,
        directory,
        projectPath: resolveProjectIdentityForSession(directory, config.allow_home_project),
        close: closeDatabase,
    };
}
