import type { ContextDatabase } from "../../features/magic-context/storage";
import { logSlowWriteTransaction } from "../../shared/write-transaction-timing";

/** Pairs currently open on this thread; the work inside one is synchronous. */
let pairDepth = 0;

/** Commit a synchronous edit and its required thinking omissions as one decision. */
export function pairedThinkingEdit<T>(args: {
    db: ContextDatabase;
    messages: unknown[];
    edit: () => T;
    needsCompanion: (result: T) => boolean;
    persistCompanion: (result: T) => void;
    state?: object;
    onRollback?: () => void;
}): T {
    const before = snapshotRender(args.messages);
    const state = args.state ? { ...args.state } : undefined;
    // A nested pair runs as a savepoint inside its caller's write transaction;
    // only the outermost one acquires, and so measures, the write lock.
    const outermost = pairDepth === 0;
    let heldFrom = 0;
    try {
        const result = args.db
            .transaction(() => {
                heldFrom = performance.now();
                pairDepth++;
                try {
                    const result = args.edit();
                    if (result && typeof (result as { then?: unknown }).then === "function")
                        throw new Error(
                            "A thinking companion transaction cannot contain awaited work",
                        );
                    if (args.needsCompanion(result)) args.persistCompanion(result);
                    return result;
                } finally {
                    pairDepth--;
                }
            })
            .immediate();
        if (outermost) logSlowWriteTransaction("paired_thinking_edit", heldFrom);
        return result;
    } catch (error) {
        restoreCaller(args, before, state);
        throw error;
    }
}

/** Thrown by an edit running outside the companion transaction when it reaches a
 * decision whose thinking omissions must commit together with it. */
export class CompanionPairingRequired extends Error {
    constructor() {
        super("This edit must commit together with its thinking omissions");
    }
}

/**
 * Run an edit that is expected to need no thinking omissions without opening a
 * write transaction. A pass that writes nothing then takes no write lock, and
 * each write holds it only for its own statement or short transaction, exactly
 * as an unpaired pass does.
 *
 * The edit must call `requirePairing` before the first write that could need
 * omissions. That call aborts this attempt: the caller's render and in-memory
 * state are restored and `undefined` is returned, so the caller reruns the work
 * inside `pairedThinkingEdit`. Writes made before that point are the ones a
 * held pass makes anyway, so the rerun sees them as already applied.
 */
export function editOutsideCompanionTransaction<T>(args: {
    messages: unknown[];
    edit: (requirePairing: () => never) => T;
    state?: object;
    onRollback?: () => void;
}): { result: T } | undefined {
    const before = snapshotRender(args.messages);
    const state = args.state ? { ...args.state } : undefined;
    try {
        return {
            result: args.edit(() => {
                throw new CompanionPairingRequired();
            }),
        };
    } catch (error) {
        restoreCaller(args, before, state);
        if (error instanceof CompanionPairingRequired) return undefined;
        throw error;
    }
}

function restoreCaller(
    args: { messages: unknown[]; state?: object; onRollback?: () => void },
    before: RenderSnapshot,
    state: object | undefined,
): void {
    // SQL rollback does not restore the caller's render. A failed pair must
    // leave the same source bytes available to its refusal/replay fallback.
    // Every message, part and nested container is restored in place, keeping
    // its object identity: hosts map message objects to stable entry ids and
    // later lanes hold part references, so a rerun must find the same objects.
    for (const [container, saved] of before) {
        for (const key of Reflect.ownKeys(container))
            if (!(Array.isArray(container) && key === "length"))
                Reflect.deleteProperty(container, key);
        // Private host metadata must stay non-enumerable after rollback;
        // assignment would make those properties visible to JSON.
        for (const [key, descriptor] of saved) Object.defineProperty(container, key, descriptor);
    }
    if (args.state && state) {
        for (const key of Object.keys(args.state))
            if (!(key in state)) Reflect.deleteProperty(args.state, key);
        Object.assign(args.state, state);
    }
    args.onRollback?.();
}

/** Each reachable JSON container with its own properties as they were. */
type RenderSnapshot = Map<object, [PropertyKey, PropertyDescriptor][]>;

function snapshotRender(messages: unknown[]): RenderSnapshot {
    const saved: RenderSnapshot = new Map();
    const visit = (value: unknown): void => {
        if (value === null || typeof value !== "object" || saved.has(value)) return;
        const prototype = Object.getPrototypeOf(value);
        // These lanes edit JSON containers, not opaque extension instances.
        // Leave opaque values and callbacks as they are rather than rejecting a
        // valid host render.
        if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return;
        const entries: [PropertyKey, PropertyDescriptor][] = [];
        saved.set(value, entries);
        for (const key of Reflect.ownKeys(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor) continue;
            entries.push([key, descriptor]);
            if ("value" in descriptor) visit(descriptor.value);
        }
    };
    visit(messages);
    return saved;
}

export function todoCompanionRequired(
    before: { messageId: string; callId: string; stateJson: string } | null,
    after: { messageId: string; callId: string; stateJson: string } | null,
    source: readonly { id: string | undefined; thinking: boolean }[],
    headId?: string,
): boolean {
    if (JSON.stringify(before) === JSON.stringify(after)) return false;
    let lastThinking = -1;
    for (let index = 0; index < source.length; index++)
        if (source[index].thinking) lastThinking = index;
    if (lastThinking < 0) return false;
    return [before, after].some((anchor) => {
        if (!anchor) return false;
        if (headId && anchor.messageId === headId) return true;
        const index = source.findIndex((message) => message.id === anchor.messageId);
        return index >= 0 && index < lastThinking;
    });
}

export function snapshotSessionFlag(flags: Set<string>, sessionId: string): () => void {
    const before = flags.has(sessionId);
    return () => {
        if (before) flags.add(sessionId);
        else flags.delete(sessionId);
    };
}

export function snapshotSessionValue<T>(
    values: {
        get(id: string): T | undefined;
        set(id: string, value: T): unknown;
        delete(id: string): unknown;
    },
    sessionId: string,
): () => void {
    const before = values.get(sessionId);
    return () => {
        if (before === undefined) values.delete(sessionId);
        else values.set(sessionId, before);
    };
}
