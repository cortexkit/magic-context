import { BoundedSessionMap } from "../../../shared/bounded-session-map";
import { getHarness, type HarnessId } from "../../../shared/harness";
import { sessionLog } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { recordSessionProjectIdentity } from "../session-project-storage";
import { identityMergeCommand } from "./identity-merge-command";
import { directoryFallback } from "./project-identity";
import { getMemoryCount } from "./storage-memory";

const observedBindings = new WeakMap<Database, BoundedSessionMap<BindingObservation>>();

interface BindingObservation {
    directory: string;
    noticed: Set<string>;
}

function bindingLog(
    harness: HarnessId,
    directory: string,
    old: string | undefined,
    identity: string,
    memories: number,
): string {
    return `project binding changed harness=${harness} cwd=${directory || "unknown"} old=${old ?? "none"} new=${identity} memories=${memories}`;
}

/** Observe a host-owned binding on its request path. Background repairs do not have a user to notify. */
export function observeSessionProjectBinding(
    db: Database,
    sessionId: string,
    identity: string,
    directory: string,
    notify?: (text: string) => void,
): void {
    const change = recordSessionProjectIdentity(db, sessionId, identity);
    const harness = getHarness();
    let observations = observedBindings.get(db);
    if (!observations) {
        observations = new BoundedSessionMap(1000);
        observedBindings.set(db, observations);
    }
    const key = `${harness}\0${sessionId}`;
    const last = observations.get(key);
    const noticed = last?.noticed ?? new Set<string>();
    observations.set(key, { directory, noticed });

    const old = change?.previousProjectPath;
    if (!change || (!old && harness !== "pi" && harness !== "omp")) return;
    const memories = old ? getMemoryCount(db, old) : 0;
    const binding = bindingLog(harness, directory, old, identity, memories);
    if (!old || !memories || noticed.has(old)) {
        sessionLog(sessionId, binding);
        return;
    }

    // A hash cannot be reversed. Use a folder only if an observed spelling hashes to the old key.
    const oldDirectory = [last?.directory, directory].find(
        (path) => path && directoryFallback(path) === old,
    );
    const location = oldDirectory ? `the old folder (${oldDirectory})` : `the old project (${old})`;
    let notice = `This session changed projects. ${memories} ${memories === 1 ? "memory stayed" : "memories stayed"} with ${location}; nothing moved.`;
    if (old.startsWith("dir:") && /^(dir|git):/.test(identity)) {
        notice += ` To move them here, close all Magic Context hosts and run: ${identityMergeCommand(oldDirectory ?? old, identity)}`;
    } else if (old.startsWith("git:") && identity.startsWith("dir:")) {
        notice += " A repository's memories cannot be merged into a folder project.";
    } else {
        notice +=
            " Doctor cannot safely offer a merge command without verifying the project directories.";
    }
    noticed.add(old);
    // Also keep the instructions in the log for clients without a notice surface.
    sessionLog(sessionId, `${binding} notice=${JSON.stringify(notice)}`);
    try {
        notify?.(notice);
    } catch {
        // The log above remains available if the UI is closing or unavailable.
    }
}
