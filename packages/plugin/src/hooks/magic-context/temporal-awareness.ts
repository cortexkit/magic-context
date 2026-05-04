/**
 * Temporal awareness utilities.
 *
 * When enabled via experimental.temporal_awareness, the plugin:
 *   1. Prepends <!-- +Xm --> / <!-- +2h 15m --> / <!-- +3d 4h --> HTML comments
 *      to user messages where the gap since the previous message exceeds
 *      TEMPORAL_AWARENESS_THRESHOLD_SECONDS.
 *   2. Adds start="YYYY-MM-DD" end="YYYY-MM-DD" date attributes to <compartment>
 *      elements in the injected <session-history> block.
 *
 * The gap is measured from the previous message's effective end time:
 *   - Assistant (completed): prev.time.completed
 *   - Assistant (in-flight/aborted): prev.time.created (best available)
 *   - User: prev.time.created (user messages have no completed field)
 *
 * All values are derived deterministically from immutable message timestamps,
 * so injection is stable across transform passes and cache-safe.
 */

/** User message gaps below this threshold get no marker. 5 minutes. */
export const TEMPORAL_AWARENESS_THRESHOLD_SECONDS = 300;

/** Seconds per unit for gap formatting. */
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * 60;
const SECONDS_PER_DAY = 24 * 60 * 60;
const SECONDS_PER_WEEK = 7 * 24 * 60 * 60;

/**
 * Format a gap in seconds as a compact adaptive string.
 * Returns null for gaps below the threshold (no marker should be injected).
 *
 *   < 5 min   → null
 *   5 min - 1 hour    → "+Xm"          (e.g. "+12m")
 *   1 hour - 1 day    → "+Xh Ym" / "+Xh" when Y == 0
 *   1 day - 1 week    → "+Xd Yh" / "+Xd" when Y == 0
 *   >= 1 week         → "+Xw Yd" / "+Xw" when Y == 0
 *
 * Non-finite, negative, or zero deltas return null.
 */
export function formatGap(seconds: number): string | null {
    if (!Number.isFinite(seconds) || seconds < TEMPORAL_AWARENESS_THRESHOLD_SECONDS) {
        return null;
    }

    if (seconds < SECONDS_PER_HOUR) {
        const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
        return `+${minutes}m`;
    }

    if (seconds < SECONDS_PER_DAY) {
        const hours = Math.floor(seconds / SECONDS_PER_HOUR);
        const minutes = Math.floor((seconds - hours * SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
        return minutes === 0 ? `+${hours}h` : `+${hours}h ${minutes}m`;
    }

    if (seconds < SECONDS_PER_WEEK) {
        const days = Math.floor(seconds / SECONDS_PER_DAY);
        const hours = Math.floor((seconds - days * SECONDS_PER_DAY) / SECONDS_PER_HOUR);
        return hours === 0 ? `+${days}d` : `+${days}d ${hours}h`;
    }

    const weeks = Math.floor(seconds / SECONDS_PER_WEEK);
    const days = Math.floor((seconds - weeks * SECONDS_PER_WEEK) / SECONDS_PER_DAY);
    return days === 0 ? `+${weeks}w` : `+${weeks}w ${days}d`;
}

/**
 * Compute the effective end time for a raw OpenCode message given its
 * time.created and optional time.completed fields.
 *
 * For completed assistants use `completed`; for everything else (user messages,
 * in-flight/aborted assistants) use `created`.
 */
export function effectiveEndMs(time: { created: number; completed?: number }): number {
    return time.completed ?? time.created;
}

/**
 * Format a Unix ms timestamp as YYYY-MM-DD in the process local timezone.
 * Used for compartment start/end date attributes.
 */
export function formatDate(ms: number): string {
    const d = new Date(ms);
    const yyyy = d.getFullYear().toString().padStart(4, "0");
    const mm = (d.getMonth() + 1).toString().padStart(2, "0");
    const dd = d.getDate().toString().padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

/** Regex matching the injected HTML comment so we can recognize / avoid
 *  double-injecting on retried transform passes. */
export const TEMPORAL_MARKER_PATTERN = /^<!-- \+[\d]+[mhdw](?: [\d]+[mhdw])? -->\n/;

/**
 * Produce the HTML comment prefix line for a given gap marker, or null if the
 * gap is below threshold.
 */
export function temporalMarkerPrefix(seconds: number): string | null {
    const marker = formatGap(seconds);
    if (!marker) return null;
    return `<!-- ${marker} -->\n`;
}

/**
 * Structural shape of OpenCode message metadata as seen from the runtime
 * transform. `time` is always present in OpenCode's persisted form even though
 * our narrower `MessageInfo` type doesn't declare it.
 */
type MessageLikeWithTime = {
    info: { role?: string; time?: { created?: number; completed?: number } };
    parts: unknown[];
};

type MutableTextPart = {
    type?: string;
    text?: string;
    ignored?: boolean;
};

function isMutableTextPart(part: unknown): part is MutableTextPart {
    if (part === null || typeof part !== "object") return false;
    const p = part as Record<string, unknown>;
    return p.type === "text" && typeof p.text === "string";
}

function findFirstVisibleTextPart(parts: unknown[]): MutableTextPart | null {
    for (const p of parts) {
        if (!isMutableTextPart(p)) continue;
        if (p.ignored === true) continue;
        return p;
    }
    return null;
}

/**
 * Inject HTML-comment gap markers into user-message text parts when
 * temporal awareness is enabled and the gap since the previous message's
 * effective end time exceeds TEMPORAL_AWARENESS_THRESHOLD_SECONDS.
 *
 * Idempotent: if a text already starts with a temporal marker (e.g. from a
 * previous transform pass), injection is skipped. Returns the number of
 * messages that received a new marker.
 *
 * The marker is prepended BEFORE any §N§ tag added by tagMessages runs after
 * this function, since tagging happens in the normal transform flow and
 * stripTagPrefix re-strips `§N§` on re-tagging — leaving the marker intact
 * between the tag and the user's text on subsequent passes.
 */
export function injectTemporalMarkers(messages: unknown[]): number {
    let injected = 0;
    let prev: MessageLikeWithTime | null = null;

    for (const raw of messages) {
        if (!raw || typeof raw !== "object") continue;
        const msg = raw as MessageLikeWithTime;
        const role = msg.info?.role;

        if (prev !== null && role === "user") {
            const prevTime = prev.info?.time;
            const currTime = msg.info?.time;
            if (prevTime?.created !== undefined && currTime?.created !== undefined) {
                const prevEnd = prevTime.completed ?? prevTime.created;
                const gapSec = (currTime.created - prevEnd) / 1000;
                const prefix = temporalMarkerPrefix(gapSec);
                if (prefix && Array.isArray(msg.parts)) {
                    const target = findFirstVisibleTextPart(msg.parts);
                    if (target && typeof target.text === "string") {
                        // Split off any existing §N§ tag prefix so the marker is
                        // inserted AFTER the tag (tagMessages strips-then-prepends
                        // the §N§, so keeping the marker to the right of it keeps
                        // the round-trip idempotent).
                        const tagMatch = target.text.match(/^(?:§\d+§\s*)+/);
                        const tagPrefix = tagMatch ? tagMatch[0] : "";
                        const body = target.text.slice(tagPrefix.length);
                        if (!TEMPORAL_MARKER_PATTERN.test(body)) {
                            target.text = tagPrefix + prefix + body;
                            injected++;
                        }
                    }
                }
            }
        }

        prev = msg;
    }

    return injected;
}
