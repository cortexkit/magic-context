import { describe, expect, test } from "bun:test";

import {
    effectiveEndMs,
    formatDate,
    formatGap,
    injectTemporalMarkers,
    TEMPORAL_AWARENESS_THRESHOLD_SECONDS,
    TEMPORAL_MARKER_PATTERN,
    temporalMarkerPrefix,
} from "./temporal-awareness";

function makeUserMsg(createdMs: number, text: string) {
    return {
        info: { role: "user", time: { created: createdMs } },
        parts: [{ type: "text", text }],
    };
}

function makeAssistantMsg(createdMs: number, completedMs: number | undefined, text: string) {
    const time =
        completedMs !== undefined
            ? { created: createdMs, completed: completedMs }
            : { created: createdMs };
    return {
        info: { role: "assistant", time },
        parts: [{ type: "text", text }],
    };
}

describe("formatGap", () => {
    test("returns null below threshold", () => {
        expect(formatGap(0)).toBeNull();
        expect(formatGap(60)).toBeNull();
        expect(formatGap(TEMPORAL_AWARENESS_THRESHOLD_SECONDS - 1)).toBeNull();
    });

    test("returns null for non-finite or negative values", () => {
        expect(formatGap(Number.NaN)).toBeNull();
        expect(formatGap(Number.POSITIVE_INFINITY)).toBeNull();
        expect(formatGap(-5)).toBeNull();
    });

    test("formats minute gaps at exactly the threshold", () => {
        expect(formatGap(TEMPORAL_AWARENESS_THRESHOLD_SECONDS)).toBe("+5m");
    });

    test("formats minute gaps under 1 hour", () => {
        expect(formatGap(301)).toBe("+5m");
        expect(formatGap(720)).toBe("+12m");
        expect(formatGap(59 * 60)).toBe("+59m");
    });

    test("formats hour gaps with zero-minute elision", () => {
        expect(formatGap(60 * 60)).toBe("+1h");
        expect(formatGap(2 * 60 * 60)).toBe("+2h");
    });

    test("formats hour gaps with minute remainder", () => {
        expect(formatGap(60 * 60 + 15 * 60)).toBe("+1h 15m");
        expect(formatGap(2 * 60 * 60 + 30 * 60)).toBe("+2h 30m");
        expect(formatGap(5 * 60 * 60 + 23 * 60)).toBe("+5h 23m");
    });

    test("formats day gaps with zero-hour elision", () => {
        expect(formatGap(24 * 60 * 60)).toBe("+1d");
        expect(formatGap(3 * 24 * 60 * 60)).toBe("+3d");
    });

    test("formats day gaps with hour remainder", () => {
        expect(formatGap(24 * 60 * 60 + 4 * 60 * 60)).toBe("+1d 4h");
        expect(formatGap(3 * 24 * 60 * 60 + 12 * 60 * 60)).toBe("+3d 12h");
    });

    test("formats week gaps with zero-day elision", () => {
        expect(formatGap(7 * 24 * 60 * 60)).toBe("+1w");
        expect(formatGap(2 * 7 * 24 * 60 * 60)).toBe("+2w");
    });

    test("formats week gaps with day remainder", () => {
        expect(formatGap(7 * 24 * 60 * 60 + 3 * 24 * 60 * 60)).toBe("+1w 3d");
        expect(formatGap(2 * 7 * 24 * 60 * 60 + 5 * 24 * 60 * 60)).toBe("+2w 5d");
    });
});

describe("temporalMarkerPrefix", () => {
    test("returns null when gap below threshold", () => {
        expect(temporalMarkerPrefix(0)).toBeNull();
        expect(temporalMarkerPrefix(60)).toBeNull();
    });

    test("returns full HTML comment line for above-threshold gaps", () => {
        expect(temporalMarkerPrefix(301)).toBe("<!-- +5m -->\n");
        expect(temporalMarkerPrefix(60 * 60 + 15 * 60)).toBe("<!-- +1h 15m -->\n");
        expect(temporalMarkerPrefix(7 * 24 * 60 * 60 + 3 * 24 * 60 * 60)).toBe("<!-- +1w 3d -->\n");
    });

    test("output matches the pattern regex", () => {
        const samples = [
            temporalMarkerPrefix(301),
            temporalMarkerPrefix(60 * 60),
            temporalMarkerPrefix(60 * 60 + 15 * 60),
            temporalMarkerPrefix(24 * 60 * 60),
            temporalMarkerPrefix(24 * 60 * 60 + 4 * 60 * 60),
            temporalMarkerPrefix(7 * 24 * 60 * 60),
            temporalMarkerPrefix(7 * 24 * 60 * 60 + 3 * 24 * 60 * 60),
        ];
        for (const s of samples) {
            expect(s).not.toBeNull();
            if (s) {
                expect(TEMPORAL_MARKER_PATTERN.test(s)).toBe(true);
            }
        }
    });

    test("pattern does not falsely match unrelated HTML comments", () => {
        expect(TEMPORAL_MARKER_PATTERN.test("<!-- note -->\n")).toBe(false);
        expect(TEMPORAL_MARKER_PATTERN.test("<!-- +5 -->\n")).toBe(false);
        expect(TEMPORAL_MARKER_PATTERN.test("<!-- +5m -->")).toBe(false); // missing trailing newline
    });
});

describe("effectiveEndMs", () => {
    test("uses completed when present", () => {
        expect(effectiveEndMs({ created: 1000, completed: 2000 })).toBe(2000);
    });

    test("falls back to created when completed absent", () => {
        expect(effectiveEndMs({ created: 1000 })).toBe(1000);
    });

    test("uses completed even when it is older than created (pathological case)", () => {
        // Trust the data — don't second-guess absurd timestamps at this layer.
        expect(effectiveEndMs({ created: 2000, completed: 1000 })).toBe(1000);
    });
});

describe("formatDate", () => {
    test("formats a date as YYYY-MM-DD", () => {
        // 2026-04-21 00:00:00 local time. Test with a known date.
        const ms = new Date(2026, 3, 21, 12, 0, 0).getTime(); // Apr 21 2026 noon local
        expect(formatDate(ms)).toBe("2026-04-21");
    });

    test("zero-pads single-digit month and day", () => {
        const ms = new Date(2026, 0, 5, 9, 0, 0).getTime(); // Jan 5 2026
        expect(formatDate(ms)).toBe("2026-01-05");
    });

    test("boundary: last day of year", () => {
        const ms = new Date(2026, 11, 31, 23, 59, 59).getTime(); // Dec 31 2026
        expect(formatDate(ms)).toBe("2026-12-31");
    });
});

describe("injectTemporalMarkers", () => {
    test("no-op on first user message (no previous)", () => {
        const messages = [makeUserMsg(1_000_000, "hello")];
        const n = injectTemporalMarkers(messages);
        expect(n).toBe(0);
        expect(messages[0].parts[0].text).toBe("hello");
    });

    test("below threshold: no marker (gap = 60 seconds)", () => {
        const t0 = 1_000_000_000_000;
        const messages = [
            makeAssistantMsg(t0, t0 + 10_000, "answer"),
            makeUserMsg(t0 + 70_000, "follow-up"), // 60s after completed
        ];
        expect(injectTemporalMarkers(messages)).toBe(0);
        expect(messages[1].parts[0].text).toBe("follow-up");
    });

    test("above threshold: prepends marker", () => {
        const t0 = 1_000_000_000_000;
        const messages = [
            makeAssistantMsg(t0, t0 + 10_000, "answer"), // completed at t0+10s
            makeUserMsg(t0 + 10_000 + 720 * 1000, "follow-up"), // 720s after completed
        ];
        expect(injectTemporalMarkers(messages)).toBe(1);
        expect(messages[1].parts[0].text).toBe("<!-- +12m -->\nfollow-up");
    });

    test("uses prev.time.completed when set (correct semantic for completed assistant)", () => {
        const t0 = 1_000_000_000_000;
        // Assistant took 12 minutes to run. User replied 30 seconds after completion.
        const assistantCreated = t0;
        const assistantCompleted = t0 + 12 * 60 * 1000;
        const userCreated = assistantCompleted + 30_000; // 30s after finish
        const messages = [
            makeAssistantMsg(assistantCreated, assistantCompleted, "long work"),
            makeUserMsg(userCreated, "thanks"),
        ];
        // Gap from COMPLETED = 30s -> below threshold, no marker.
        expect(injectTemporalMarkers(messages)).toBe(0);
        expect(messages[1].parts[0].text).toBe("thanks");
    });

    test("falls back to prev.time.created when completed missing (aborted/in-flight)", () => {
        const t0 = 1_000_000_000_000;
        const messages = [
            makeAssistantMsg(t0, undefined, "aborted work"), // no completed
            makeUserMsg(t0 + 10 * 60 * 1000, "retry"), // 10 min after created
        ];
        expect(injectTemporalMarkers(messages)).toBe(1);
        expect(messages[1].parts[0].text).toBe("<!-- +10m -->\nretry");
    });

    test("handles gap between two consecutive user messages", () => {
        const t0 = 1_000_000_000_000;
        const messages = [
            makeUserMsg(t0, "first"),
            makeUserMsg(t0 + 8 * 60 * 60 * 1000, "back after lunch"), // 8 hours later
        ];
        expect(injectTemporalMarkers(messages)).toBe(1);
        expect(messages[1].parts[0].text).toBe("<!-- +8h -->\nback after lunch");
    });

    test("is idempotent across passes (no double-injection)", () => {
        const t0 = 1_000_000_000_000;
        const messages = [
            makeAssistantMsg(t0, t0 + 1000, "answer"),
            makeUserMsg(t0 + 1000 + 720 * 1000, "follow-up"),
        ];
        const first = injectTemporalMarkers(messages);
        const second = injectTemporalMarkers(messages);
        expect(first).toBe(1);
        expect(second).toBe(0);
        expect(messages[1].parts[0].text).toBe("<!-- +12m -->\nfollow-up");
    });

    test("respects tag prefix — marker goes after §N§ tag", () => {
        const t0 = 1_000_000_000_000;
        const messages = [
            makeAssistantMsg(t0, t0 + 1000, "answer"),
            makeUserMsg(t0 + 1000 + 720 * 1000, "§42§ follow-up"),
        ];
        const n = injectTemporalMarkers(messages);
        expect(n).toBe(1);
        expect(messages[1].parts[0].text).toBe("§42§ <!-- +12m -->\nfollow-up");
    });

    test("idempotent even when tag prefix is present", () => {
        const t0 = 1_000_000_000_000;
        const messages = [
            makeAssistantMsg(t0, t0 + 1000, "answer"),
            makeUserMsg(t0 + 1000 + 720 * 1000, "§42§ <!-- +12m -->\nfollow-up"),
        ];
        const n = injectTemporalMarkers(messages);
        expect(n).toBe(0);
        expect(messages[1].parts[0].text).toBe("§42§ <!-- +12m -->\nfollow-up");
    });

    test("skips injection when user message has no text part", () => {
        const t0 = 1_000_000_000_000;
        const messages = [
            makeAssistantMsg(t0, t0 + 1000, "answer"),
            { info: { role: "user", time: { created: t0 + 1000 + 720 * 1000 } }, parts: [] },
        ];
        const n = injectTemporalMarkers(messages);
        expect(n).toBe(0);
    });

    test("skips ignored text parts and injects into next visible part", () => {
        const t0 = 1_000_000_000_000;
        const messages = [
            makeAssistantMsg(t0, t0 + 1000, "answer"),
            {
                info: { role: "user", time: { created: t0 + 1000 + 720 * 1000 } },
                parts: [
                    { type: "text", text: "system reminder", ignored: true },
                    { type: "text", text: "real user text" },
                ],
            },
        ];
        const n = injectTemporalMarkers(messages);
        expect(n).toBe(1);
        expect((messages[1].parts[0] as { text: string }).text).toBe("system reminder");
        expect((messages[1].parts[1] as { text: string }).text).toBe(
            "<!-- +12m -->\nreal user text",
        );
    });

    test("does not inject between assistant messages", () => {
        const t0 = 1_000_000_000_000;
        const messages = [
            makeAssistantMsg(t0, t0 + 1000, "first"),
            makeAssistantMsg(t0 + 1000 + 720 * 1000, t0 + 1000 + 720 * 1000 + 1000, "second"),
        ];
        const n = injectTemporalMarkers(messages);
        expect(n).toBe(0);
    });

    test("multiple user messages each get their own gap marker", () => {
        const t0 = 1_000_000_000_000;
        const fiveMin = 5 * 60 * 1000;
        const hour = 60 * 60 * 1000;
        const messages = [
            makeUserMsg(t0, "first"),
            makeAssistantMsg(t0 + 1000, t0 + 2000, "reply"),
            makeUserMsg(t0 + 2000 + 10 * fiveMin, "after 50 minutes"), // 50 min after completed
            makeAssistantMsg(t0 + 3 * hour, t0 + 3 * hour + 1000, "reply"),
            makeUserMsg(t0 + 3 * hour + 1000 + 8 * hour, "next day"), // 8 hours later
        ];
        const n = injectTemporalMarkers(messages);
        expect(n).toBe(2);
        expect((messages[2].parts[0] as { text: string }).text).toBe(
            "<!-- +50m -->\nafter 50 minutes",
        );
        expect((messages[4].parts[0] as { text: string }).text).toBe("<!-- +8h -->\nnext day");
    });
});
