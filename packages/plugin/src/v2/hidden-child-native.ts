import type { HiddenRunIdentity } from "../hooks/magic-context/compartment-runner-types";
import {
    childCreateInput,
    errorText,
    type HiddenChildHost,
    type HiddenChildLifecycle,
    type HiddenChildModel,
    type HiddenChildRole,
    keptUnderRetention,
    type PersistedHiddenChild,
    roleTitle,
} from "./hidden-child-record";
import type { HiddenChildHook } from "./hooks/hidden-child";

/**
 * The hidden-child lifecycle for OpenCode 2 hosts whose plugin session API has `session.remove`.
 * Every run gets a fresh root child in the run's directory, and the child is removed when the run
 * ends, whether it succeeded or failed. Nothing is recorded in context.db.
 *
 * The child is never given the user's session as its parent: OpenCode 2.3 reports every idle of a
 * parented session to its parent and wakes the parent, so each historian or dreamer run would
 * start a turn in the user's session.
 */

type RemoveSession = NonNullable<HiddenChildHost["removeSession"]>;

/**
 * The feature gate for this lifecycle: the host's own `session.remove`, bound to its session API,
 * or undefined on hosts that do not expose one to plugins. Hosts are told apart by what they
 * offer, never by version: development builds report versions such as `0.0.0-dev-20358`.
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
        hook: HiddenChildHook;
        generation: string;
        keepSubagents: boolean;
        log: (message: string) => void;
        removalTimeoutMs?: number;
    },
): HiddenChildLifecycle {
    // Removals in flight, so a finished run can wait for the removal its own failure started.
    const removing = new Map<string, Promise<void>>();

    const remove = (child: PersistedHiddenChild): Promise<void> => {
        const inFlight = removing.get(child.id);
        if (inFlight) return inFlight;
        options.log(`[magic-context] hidden child ${child.id} removing`);
        const done = (async () => {
            try {
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    await Promise.race([
                        removeSession({ sessionID: child.id }),
                        new Promise<never>((_, reject) => {
                            timer = setTimeout(
                                () => reject(new Error("session.remove timed out")),
                                options.removalTimeoutMs ?? 5000,
                            );
                        }),
                    ]);
                } finally {
                    if (timer) clearTimeout(timer);
                }
                options.log(`[magic-context] hidden child ${child.id} removed`);
            } catch (error) {
                if (isSessionNotFound(error)) return;
                options.log(
                    `[magic-context] hidden child ${child.id} could not be removed: ${errorText(error)}`,
                );
            }
        })().finally(() => {
            removing.delete(child.id);
        });
        removing.set(child.id, done);
        return done;
    };

    const create = async (
        identity: HiddenRunIdentity,
        role: HiddenChildRole,
        model: HiddenChildModel,
    ): Promise<PersistedHiddenChild> => {
        const input = childCreateInput(identity, role, model);
        const created = await host.create(input);
        if (!created.id) throw new Error("OpenCode 2 did not return a child session id");
        options.hook.registerChild(created.id, input.agent);
        options.log(
            `[magic-context] hidden child ${created.id} created role=${role} keep_subagents=${options.keepSubagents}`,
        );
        return {
            id: created.id,
            role,
            generation: options.generation,
            title: roleTitle(role),
            model,
            created_at: Date.now(),
            directory: identity.directory,
        };
    };

    // keep_subagents retains inspectable runs as root sessions of the run's directory.
    const kept = (child: PersistedHiddenChild) => keptUnderRetention(options.keepSubagents, child);

    return {
        open: create,
        create,
        retire(child) {
            if (kept(child)) {
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
                options.log(`[magic-context] hidden child ${child.id} kept (keep_subagents)`);
            } else {
                await remove(child);
            }
        },
        updateModel: (child, model) => ({ ...child, model }),
        markEverSettled: (child) => ({ ...child, ever_settled: true }),
    };
}
