import { describe, expect, test } from "bun:test";
import { HiddenModelCooldowns } from "./hidden-model-cooldown";

const epoch = Date.parse("2026-10-08T00:00:00Z");
const refusal = (seconds: string, statusCode = 412) => ({
    name: "APIError",
    data: { statusCode, responseHeaders: { "retry-after": seconds }, isRetryable: false },
});

describe("hidden model quota cooldown", () => {
    test("structured quota refusal skips across runs, expires, and is removed", () => {
        let now = epoch;
        const table = new HiddenModelCooldowns(() => now);
        const messages: string[] = [];
        table.record("google/primary", refusal("190000"));
        expect(
            table.startIndex(["google/primary", "other/fallback"], (line) => messages.push(line)),
        ).toBe(1);
        expect(messages).toEqual([
            "skipping google/primary until 2026-10-10T04:46:40.000Z: provider said to retry later",
        ]);
        now += 190_000_000;
        expect(table.startIndex(["google/primary", "other/fallback"], () => {})).toBe(0);
        expect(table.live()).toEqual([]);
    });

    test("success clears a model and providers have independent keys", () => {
        const table = new HiddenModelCooldowns(() => epoch);
        table.record("one/model", refusal("120"));
        table.record("two/model", refusal("180"));
        table.succeeded("one/model");
        expect(table.live().map((entry) => entry.model)).toEqual(["two/model"]);
        expect(table.startIndex(["one/model", "two/model"], () => {})).toBe(0);
    });

    test("all unavailable models still try the soonest, preserving subsequent fallback order", () => {
        const table = new HiddenModelCooldowns(() => epoch);
        for (const [model, delay] of [
            ["p/first", "300"],
            ["p/second", "120"],
            ["p/third", "200"],
        ])
            table.record(model, refusal(delay));
        expect(table.startIndex(["p/first", "p/second", "p/third"], () => {})).toBe(1);
        expect(table.startIndex(["p/first"], () => {})).toBe(0);
    });

    test("clamps long windows to seven days and leaves ordinary retries at sixty seconds alone", () => {
        const table = new HiddenModelCooldowns(() => epoch);
        table.record("p/long", refusal("99999999"));
        table.record("p/short", refusal("60"));
        table.record("p/above-floor", refusal("61"));
        expect(table.live()).toEqual([
            {
                model: "p/long",
                until: epoch + 604_800_000,
                reason: "provider said to retry later",
            },
            {
                model: "p/above-floor",
                until: epoch + 61_000,
                reason: "provider said to retry later",
            },
        ]);
    });

    test("accepts HTTP dates and OpenCode 2.2 millisecond delays with not-now statuses", () => {
        const table = new HiddenModelCooldowns(() => epoch);
        table.record("p/date", refusal("Thu, 08 Oct 2026 00:02:00 GMT", 429));
        table.record("p/oc2", {
            type: "provider.overloaded",
            status: 503,
            retryAfterMs: 190_000_000,
        });
        table.record("p/sdk", {
            statusCode: 412,
            data: { error: "quota" },
            responseHeaders: { "Retry-After": "120" },
        });
        table.record("p/rfc850", refusal("Thursday, 08-Oct-26 00:02:00 GMT"));
        table.record("p/asctime", refusal("Thu Oct  8 00:02:00 2026"));
        expect(table.live().map((entry) => entry.until)).toEqual([
            epoch + 120_000,
            epoch + 190_000_000,
            epoch + 120_000,
            epoch + 120_000,
            epoch + 120_000,
        ]);
    });

    test("ignores missing, invalid, nonfinite, past and prose reset times and unrelated failures", () => {
        const table = new HiddenModelCooldowns(() => epoch);
        const failures: unknown[] = [
            { data: { statusCode: 412, message: "Quota resets in 52h 38m" } },
            { type: "provider.rate-limit", status: 429, message: "Quota exhausted" },
            new Error("timeout"),
            refusal("190000", 500),
            refusal("190000", 401),
            refusal("190000", 404),
            ...[
                "0",
                "-1",
                "1.5",
                "NaN",
                "Infinity",
                "1e10",
                "52h 38m",
                "120 seconds",
                "Wed, 07 Oct 2026 00:00:00 GMT",
            ].map((delay) => refusal(delay)),
            { status: 429, retryAfterMs: Number.POSITIVE_INFINITY },
            { status: 429, retryAfterMs: Number.NaN },
        ];
        for (const error of failures) table.record("p/model", error);
        expect(table.live()).toEqual([]);
    });
});
