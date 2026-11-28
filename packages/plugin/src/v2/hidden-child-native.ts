import type { HiddenRunIdentity } from "../hooks/magic-context/compartment-runner-types";
import type { Database } from "../shared/sqlite";
import {
    childCreateInput,
    errorText,
    type HiddenChildHost,
    type HiddenChildLifecycle,
    type HiddenChildModel,
    type HiddenChildRole,
    type HiddenChildSetupBudget,
    keptUnderRetention,
    type PersistedHiddenChild,
    roleTitle,
} from "./hidden-child-record";
import {
    extendHiddenChildDeadline,
    forgetHiddenChild,
    recordHiddenChild,
    recordRetiringHiddenChild,
} from "./hidden-child-sweep";
import {
    hiddenRunPlacement,
    matchesHiddenRunLocation,
    supportsQuietHiddenChildren,
} from "./hidden-run-holder";
import { type HiddenChildHook, noteTimedOutHiddenChild } from "./hooks/hidden-child";

/**
 * The hidden-child lifecycle for OpenCode 2 hosts whose plugin session API has `session.remove`.
 * Every run gets a fresh session in its directory, and the session is removed when the run
 * ends, whether it succeeded or failed. A context.db record survives failed removal or a crash
 * so an age-gated sweep can retry without touching another instance's live run.
 *
 * A hidden run is never parented to the user's session: some hosts wake the parent, and
 * a running child could otherwise suppress the user's own completion notification.
 */

type RemoveSession = NonNullable<HiddenChildHost["removeSession"]>;

// Plugin instances share a process. A sweep from one instance must not remove another's run.
const liveChildren = new Set<string>();
export function isLiveHiddenChild(id: string): boolean {
    return liveChildren.has(id);
}

/**
 * The feature gate for this lifecycle: the host's own `session.remove`, bound to its session API,
 * or undefined on hosts that do not expose one to plugins. Detect the API by capability;
 * even development builds can have it, despite reporting versions like `0.0.0-dev-20358`.
 */
export function nativeSessionRemove(session: object): RemoveSession | undefined {
    const remove = (session as { remove?: unknown }).remove;
    if (typeof remove !== "function") return undefined;
    return (input) => Promise.resolve(remove.call(session, { sessionID: input.sessionID }));
}

/** True when the host reports that the session is already gone. */
export function isSessionNotFound(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const fields = error as { status?: unknown; name?: unknown; _tag?: unknown; message?: unknown };
    if (fields.status === 404) return true;
    const label = [fields.name, fields._tag, fields.message]
        .filter((value): value is string => typeof value === "string")
        .join(" ");
    return /not\s*found/i.test(label);
}

export function createNativeHiddenChildren(
    host: HiddenChildHost,
    removeSession: RemoveSession,
    options: {
        db: Database;
        hook: HiddenChildHook;
        generation: string;
        hostVersion?: string;
        keepSubagents: boolean;
        log: (message: string) => void;
        removalTimeoutMs?: number;
    },
): HiddenChildLifecycle {
    const quiet = supportsQuietHiddenChildren(options.hostVersion);
    // Removals in flight, so a finished run can wait for the removal its own failure started.
    const removing = new Map<string, Promise<void>>();
    const removeBounded = async (id: string, timeoutMs = options.removalTimeoutMs ?? 5000) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                removeSession({ sessionID: id }),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () => reject(new Error("session.remove timed out")),
                        timeoutMs,
                    );
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    };

    const remove = (child: PersistedHiddenChild): Promise<void> => {
        const inFlight = removing.get(child.id);
        if (inFlight) return inFlight;
        options.log(`[magic-context] hidden child ${child.id} removing`);
        const done = (async () => {
            try {
                await removeBounded(child.id);
                forgetHiddenChild(options.db, child.id);
                options.log(`[magic-context] hidden child ${child.id} removed`);
            } catch (error) {
                if (isSessionNotFound(error)) {
                    try {
                        forgetHiddenChild(options.db, child.id);
                    } catch (storeError) {
                        options.log(
                            `[magic-context] hidden child ${child.id} record cleanup deferred: ${errorText(storeError)}`,
                        );
                    }
                    return;
                }
                options.log(
                    `[magic-context] hidden child ${child.id} could not be removed: ${errorText(error)}`,
                );
            }
        })().finally(() => {
            removing.delete(child.id);
            // Failed removals remain durable retries, not live runs that the sweep must skip.
            liveChildren.delete(child.id);
        });
        removing.set(child.id, done);
        return done;
    };

    const retireLate = async (
        id: string,
        directory: string,
        createdAt: number,
        cleanupMs: number,
    ): Promise<void> => {
        noteTimedOutHiddenChild(id);
        liveChildren.delete(id);
        try {
            recordRetiringHiddenChild(options.db, { id, directory, created_at: createdAt });
        } catch (error) {
            const kind = error instanceof Error ? error.constructor.name : typeof error;
            options.log(`[magic-context] late hidden child ${id} record failed (${kind})`);
            // Still try to remove the child when durable cleanup cannot be recorded.
        }
        try {
            await removeBounded(id, cleanupMs);
        } catch (error) {
            if (!isSessionNotFound(error)) {
                options.log(`[magic-context] late hidden child ${id} could not be removed`);
                return;
            }
        }
        try {
            forgetHiddenChild(options.db, id);
        } catch {
            // A remaining record is harmless: the sweep treats not-found as confirmation.
        }
    };

    const create = async (
        identity: HiddenRunIdentity,
        role: HiddenChildRole,
        model: HiddenChildModel,
        budget?: HiddenChildSetupBudget,
    ): Promise<PersistedHiddenChild> => {
        const input = childCreateInput(identity, role, model);
        const directory = identity.directory;
        if (quiet) {
            if (!host.createHolder)
                throw new Error("OpenCode 2 background holder API is not wired");
            const placement = await hiddenRunPlacement(host.createHolder, directory, budget);
            input.id = placement.id;
            input.parentID = placement.parentID;
            delete input.location;
        }
        budget?.setStage("creating the child session");
        const start = () => host.create(input);
        const removeLate = ({ id }: Awaited<ReturnType<typeof start>>) => {
            if (!id || !budget) return;
            // The child was created before it was recorded as live, but the sweep needs its ID if removal fails.
            void retireLate(id, directory, Date.now(), budget.cleanupMs);
        };
        const created = await (budget?.work(start, removeLate) ?? start());
        try {
            budget?.check();
        } catch (error) {
            removeLate(created);
            throw error;
        }
        if (!created.id) throw new Error("OpenCode 2 did not return a child session id");
        const createdAt = Date.now();
        liveChildren.add(created.id);
        if (!options.keepSubagents) {
            try {
                recordHiddenChild(options.db, {
                    id: created.id,
                    directory,
                    created_at: createdAt,
                    deadline_at: createdAt + identity.timeoutMs,
                });
            } catch (storeError) {
                let removed = false;
                try {
                    await removeBounded(created.id);
                    removed = true;
                } catch (error) {
                    removed = isSessionNotFound(error);
                } finally {
                    liveChildren.delete(created.id);
                }
                options.log(
                    `[magic-context] hidden child ${created.id} record failed; removed=${removed}: ${errorText(storeError)}`,
                );
                throw storeError;
            }
        }
        const child: PersistedHiddenChild = {
            id: created.id,
            role,
            generation: options.generation,
            title: roleTitle(role),
            model,
            created_at: createdAt,
            directory,
        };
        // A different ID could re-enable OpenCode's report to the parent. A different
        // parent or location could send the prompt to a plugin instance that did not register it.
        if (
            input.parentID &&
            (created.id !== input.id ||
                created.parentID !== input.parentID ||
                !matchesHiddenRunLocation(directory, created.location?.directory))
        ) {
            await remove(child);
            throw new Error(`OpenCode created a background run outside its holder at ${directory}`);
        }
        options.hook.registerChild(created.id, input.agent);
        options.log(
            `[magic-context] hidden child ${created.id} created role=${role} keep_subagents=${options.keepSubagents}`,
        );
        return child;
    };

    // keep_subagents retains inspectable runs, including children under a permanent holder.
    const kept = (child: PersistedHiddenChild) => keptUnderRetention(options.keepSubagents, child);

    return {
        open: create,
        create,
        retireLate(child, cleanupMs) {
            void retireLate(child.id, child.directory ?? "", child.created_at, cleanupMs);
        },
        retire(child) {
            if (kept(child)) {
                liveChildren.delete(child.id);
                options.log(`[magic-context] hidden child ${child.id} kept (keep_subagents)`);
            } else {
                void remove(child);
            }
        },
        async finish(child, retired) {
            if (retired) {
                await removing.get(child.id);
                return;
            }
            if (kept(child)) {
                liveChildren.delete(child.id);
                options.log(`[magic-context] hidden child ${child.id} kept (keep_subagents)`);
            } else {
                await remove(child);
            }
        },
        extendDeadline(child, deadlineAt) {
            if (options.keepSubagents) return;
            try {
                extendHiddenChildDeadline(options.db, child.id, deadlineAt);
            } catch (error) {
                options.log(
                    `[magic-context] hidden child ${child.id} deadline update deferred: ${errorText(error)}`,
                );
            }
        },
        updateModel: (child, model) => ({ ...child, model }),
        markEverSettled: (child) => ({ ...child, ever_settled: true }),
    };
}
