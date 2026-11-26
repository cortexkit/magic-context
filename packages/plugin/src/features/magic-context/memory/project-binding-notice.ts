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
    warning?: string;
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
    const observation: BindingObservation = {
        directory,
        noticed,
        warning: change ? undefined : last?.warning,
    };
    observations.set(key, observation);

    const old = change?.previousProjectPath;
    if (!change || (!old && harness !== "pi" && harness !== "omp")) return;
    const memories = old ? getMemoryCount(db, old) : 0;
    const binding = bindingLog(harness, directory, old, identity, memories);
    if (!old || !memories) {
        sessionLog(sessionId, binding);
        return;
    }

    // A hash cannot be reversed. Use a folder only if an observed spelling hashes to the old key.
    const oldDirectory = [last?.directory, directory].find(
        (path) => path && directoryFallback(path) === old,
    );
    const location = oldDirectory ? `the old folder (${oldDirectory})` : `the old project (${old})`;
    let guidance: string;
    if (old.startsWith("dir:") && /^(dir|git):/.test(identity)) {
        guidance = `To move them here, close all Magic Context hosts and run: ${identityMergeCommand(oldDirectory ?? old, identity)}`;
    } else if (old.startsWith("git:") && identity.startsWith("dir:")) {
        guidance = "A repository's memories cannot be merged into a folder project.";
    } else {
        guidance =
            "Doctor cannot safely offer a merge command without verifying the project directories.";
    }
    const count = `${memories} ${memories === 1 ? "memory" : "memories"}`;
    observation.warning = `${count} stayed under this session's previous project. Nothing was moved.\n${guidance}`;
    if (noticed.has(old)) {
        sessionLog(sessionId, binding);
        return;
    }

    noticed.add(old);
    const notice = `This session changed projects. ${count} stayed with ${location}; nothing moved. ${guidance}`;
    // Also keep the instructions in the log for clients without a notice surface.
    sessionLog(sessionId, `${binding} notice=${JSON.stringify(notice)}`);
    try {
        notify?.(notice);
    } catch {
        // The log above remains available if the UI is closing or unavailable.
    }
}

export function getProjectBindingWarning(db: Database, sessionId: string): string | undefined {
    return observedBindings.get(db)?.peek(`${getHarness()}\0${sessionId}`)?.warning;
}
