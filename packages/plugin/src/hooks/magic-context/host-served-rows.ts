/**
 * Host rows that keep a raw-message ordinal but never reach the provider under
 * their own message id.
 *
 * OpenCode 2 stores instruction updates ("Today's date is now: ...", changed
 * AGENTS.md files) as `system` rows in `session_message`. They are part of the
 * raw-message ordinal space, yet the host renders them into the request draft as
 * an id-less system message. A compartment that ends on such a row names a
 * boundary no request ever contains, so every trim that looks the boundary up by
 * id fails and injection falls back to serving the whole history raw.
 *
 * The rule, matching the Pi adapter's handling of transcript system entries:
 * ordinals stay continuous, but such a row is never a compartment boundary. A
 * boundary always lands on a row the host serves with its id; an unserved row at
 * the edge of a compartment stays in the raw tail instead.
 *
 * Only the OpenCode 2 store projection marks rows. The flag is a non-enumerable
 * property so v1 and Pi objects, their JSON fixtures and golden outputs are
 * unchanged.
 */

import type { MessageLike } from "./tag-messages";

/** A staged row edit becomes durable only after dependent reasoning decisions commit. */
export interface HostRowReclaim {
    edits: readonly MessageLike[];
    commit(): void;
}

const HOST_UNSERVED_ROW = "hostUnservedRow";

/** Mark a raw message (or a chunk line derived from one) as a row the host never serves by id. */
export function markHostUnservedRow<T extends object>(target: T): T {
    Object.defineProperty(target, HOST_UNSERVED_ROW, {
        value: true,
        enumerable: false,
        configurable: true,
    });
    return target;
}

export function isHostUnservedRow(value: unknown): boolean {
    return (
        typeof value === "object" &&
        value !== null &&
        (value as Record<string, unknown>)[HOST_UNSERVED_ROW] === true
    );
}

/**
 * Move an exclusive end ordinal back so the last included ordinal is a row the
 * host serves. `floor` is the smallest ordinal the range may still include; the
 * result never drops below it, so an all-unserved range becomes empty rather
 * than reaching into history that is already summarized.
 */
export function retreatPastHostUnservedRows(
    messages: ReadonlyArray<{ ordinal: number }>,
    exclusiveEnd: number,
    floor: number,
): number {
    if (!messages.some(isHostUnservedRow)) return exclusiveEnd;
    const byOrdinal = new Map(messages.map((message) => [message.ordinal, message]));
    let end = exclusiveEnd;
    while (end - 1 >= floor && isHostUnservedRow(byOrdinal.get(end - 1))) end -= 1;
    return end;
}

/**
 * Pull the final compartment's end back onto the nearest row the host serves.
 * Only the final compartment defines the boundary a request is trimmed at; an
 * earlier compartment's end is followed by the next compartment's start, so
 * moving it would open a gap. A final compartment made only of unserved rows is
 * dropped: those rows stay raw and the next historian run covers them.
 */
export function snapTerminalCompartmentToServedRow<
    T extends { startMessage: number; endMessage: number; endMessageId: string },
>(
    compartments: readonly T[],
    lines: ReadonlyArray<{ ordinal: number; messageId: string }>,
): { compartments: T[]; snapped: boolean } {
    if (!lines.some(isHostUnservedRow)) return { compartments: [...compartments], snapped: false };
    const byOrdinal = new Map(lines.map((line) => [line.ordinal, line]));
    const result = [...compartments];
    let snapped = false;
    while (result.length > 0) {
        const last = result[result.length - 1];
        if (!isHostUnservedRow(byOrdinal.get(last.endMessage))) break;
        snapped = true;
        let served: { ordinal: number; messageId: string } | undefined;
        for (let ordinal = last.endMessage - 1; ordinal >= last.startMessage; ordinal -= 1) {
            const line = byOrdinal.get(ordinal);
            if (line && !isHostUnservedRow(line)) {
                served = line;
                break;
            }
        }
        if (!served) {
            result.pop();
            continue;
        }
        result[result.length - 1] = {
            ...last,
            endMessage: served.ordinal,
            endMessageId: served.messageId,
        };
        break;
    }
    return { compartments: result, snapped };
}

/** An id-less system message is the host's rendering of an unserved instruction row. */
export function isHostRenderedSystemMessage(message: {
    info: { id?: unknown; role?: unknown };
}): boolean {
    const id = message.info.id;
    return (typeof id !== "string" || id.length === 0) && message.info.role === "system";
}

const COVERED_INSTRUCTION_ROW = "coveredInstructionRow";
const HOST_INSTRUCTION_ROW = "hostInstructionRow";
const RETIRED_INSTRUCTION_ROW = "retiredInstructionRow";

/** Store coordinates are internal observations, not part of the served request identity. */
export function markHostInstructionRow(target: object, row: unknown): void {
    Object.defineProperty(target, HOST_INSTRUCTION_ROW, {
        value: row,
        enumerable: false,
        configurable: true,
    });
}

export function hostInstructionRow(target: object): unknown {
    return (target as Record<string, unknown>)[HOST_INSTRUCTION_ROW];
}

export function hostInstructionRowID(target: object): string | undefined {
    const row = hostInstructionRow(target) as { id?: unknown } | undefined;
    return typeof row?.id === "string" && row.id.length > 0 ? row.id : undefined;
}

/** Mark only a retirement whose replay decision is already durable. */
export function markRetiredInstructionRow(target: object): void {
    Object.defineProperty(target, RETIRED_INSTRUCTION_ROW, {
        value: true,
        enumerable: false,
        configurable: true,
    });
}

export function isRetiredInstructionRow(target: object): boolean {
    return (target as Record<string, unknown>)[RETIRED_INSTRUCTION_ROW] === true;
}

/**
 * Mark an id-less instruction message that OpenCode 2's context hook restored
 * from before the history boundary. After a host checkpoint the host no longer
 * sends those rows, so the hook restores them, and the transform decides whether
 * this session serves them (see storage-host-instruction-retention.ts).
 * Non-enumerable, like `markHostUnservedRow`, so the request bytes are unchanged.
 */
export function markCoveredInstructionRow<T extends object>(target: T): T {
    Object.defineProperty(target, COVERED_INSTRUCTION_ROW, {
        value: true,
        enumerable: false,
        configurable: true,
    });
    return target;
}

export function isCoveredInstructionRow(value: unknown): boolean {
    return (
        typeof value === "object" &&
        value !== null &&
        (value as Record<string, unknown>)[COVERED_INSTRUCTION_ROW] === true
    );
}

/**
 * Remove the messages whose `info` carries the covered-instruction mark and
 * return them in order. The array keeps every other message in place.
 */
export function takeCoveredInstructionRows<T extends { info: object }>(messages: T[]): T[] {
    const taken = messages.filter((message) => isCoveredInstructionRow(message.info));
    if (taken.length > 0) {
        const kept = messages.filter((message) => !isCoveredInstructionRow(message.info));
        messages.splice(0, messages.length, ...kept);
    }
    return taken;
}

/**
 * A deep copy of `messages` whose covered instruction rows keep their mark.
 * Cloning drops the non-enumerable mark, and a pass re-run from the copy (the
 * signed-thinking fit retry) would then serve those rows as ordinary host rows
 * instead of setting them aside.
 */
export function cloneKeepingCoveredInstructionMarks<T extends { info: object }>(
    messages: T[],
): T[] {
    const copy = structuredClone(messages);
    messages.forEach((message, index) => {
        const copied = copy[index];
        if (copied && isCoveredInstructionRow(message.info)) markCoveredInstructionRow(copied.info);
        const row = hostInstructionRow(message.info);
        if (copied && row !== undefined) markHostInstructionRow(copied.info, row);
        if (copied && isRetiredInstructionRow(message.info)) markRetiredInstructionRow(copied.info);
    });
    return copy;
}
