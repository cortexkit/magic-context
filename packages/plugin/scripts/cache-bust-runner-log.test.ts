import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestTempDir } from "../src/shared/test-temp-dir";
import { analyzeRunnerFeed } from "./cache-bust-runner-analyzer";
import { classifyRunnerStep } from "./cache-bust-runner-classification";
import type { RunnerFeedRow } from "./cache-bust-runner-feed";
import { parseRunnerDecision } from "./cache-bust-runner-log";
import { loadRunnerHeads } from "./cache-bust-runner-monitor";

const fixturePath = fileURLToPath(new URL("./fixtures/cache-bust-runner-structured.log.txt", import.meta.url));
const lines = (await Bun.file(fixturePath).text()).trimEnd().split("\n");
const fixture = (message: string, session: string) => {
    const line = lines.find((line) => line.includes(`ck-mc: session: ${message} session=${session} `));
    if (!line) throw new Error(`missing fixture: ${message} for ${session}`);
    return line;
};
const at = (time: string) => Date.parse(`2026-11-26T${time}Z`);
const structured = (body: string) => `2026-11-26T14:50:32.940Z INFO  magic-context: ck-mc: session: ${body}`;
const head = "ses_996f2ec3ef0b535d60baa17f4d05dec6";
const uuid = "019de471-4fdc-762d-9286-624dfad0b5fe";
const summarySession = "ses_126dd595aa34447d9216fba52636420d";
const rewriteSession = "ses_331acff95fferWZOYF1pG0cjOn";

test("structured setup records the harness and preset", () => {
    const line = fixture("setup", head);
    expect(parseRunnerDecision(line, head)).toMatchObject({ kind: "setup", at: at("14:42:33.871"), line });
});

test("structured view acceptance records the edit count and cut", () => {
    const line = fixture("view accepted", uuid);
    expect(parseRunnerDecision(line, uuid)).toEqual({ kind: "view", version: 67, at: at("14:44:12.004"), detail: "view=67 edits=26 cut=5378d271", line });
    expect(parseRunnerDecision(line, head)).toBeNull();
});

test("structured view acceptance uses the handover in note, not the confirmation time", () => {
    const line = structured('view accepted session=s1 view_version=38 edit_count=31 cut="no cut" note="; confirmed by the runner after its apply answer was lost; handed over at 2026-11-26T14:50:31.803Z"');
    expect(parseRunnerDecision(line, "s1")).toEqual({ kind: "view", version: 38, at: at("14:50:31.803"), detail: "view=38 edits=31 cut=none", line });
});

test("structured view refusals have the refused version, including at a step boundary", () => {
    for (const message of ["runner refused a view", "runner refused a view at a step boundary"]) {
        const line = structured(`${message} session=s1 view_version=2 refusal=BadChecksum`);
        expect(parseRunnerDecision(line, "s1")).toMatchObject({ kind: "view_refused", version: 2, line });
    }
});

test("structured unknown view answers are distinct from refusals", () => {
    const line = structured("unknown answer to a view session=s1 view_version=3 answer=Unknown");
    expect(parseRunnerDecision(line, "s1")).toMatchObject({ kind: "view_unknown", version: 3, line });
});

test("structured re-offer failures have the version even when it is inside the operation field", () => {
    for (const line of [
        fixture("runner refused a view offered again", "s1"),
        structured("unknown answer to a view offered again session=s1 view_version=2 answer=Unknown"),
        structured('rebuilding a view instead of offering it again session=s1 view_version=2 reason="saved without its policy members"'),
        structured('runner operation failed session=s1 operation="offering view 2 again" error="route not found"'),
    ]) expect(parseRunnerDecision(line, "s1")).toMatchObject({ kind: "view_reoffer_failed", version: 2, line });
    for (const body of [
        "a view is offered again on the next notice because the runner can't place its cut yet session=s1 view_version=2",
        'no answer to a view offered again, which the runner may hold; waiting for the runner\'s next report session=s1 view_version=2 error="no answer"',
        'runner operation failed session=s1 operation=session.entries error="offering view 2 again failed"',
    ]) expect(parseRunnerDecision(structured(body), "s1")).toBeNull();
});

test("structured stale readings are retained as evidence, not an accepted view", () => {
    const line = fixture("ignoring a prompt reading from a stale view; waiting for a reading under the current view", uuid);
    expect(parseRunnerDecision(line, uuid)).toMatchObject({ kind: "stale_reading", at: at("14:44:55.790"), line });
});

test("structured ride evidence uses only the request and its causes explain a rewrite", () => {
    const session = "alfonso:bg_7c59ae83a7681858";
    const request = structured(`the runner requested a ride session=${session} causes="[ChainReset]" request_tokens=Some(430000) last_prompt_tokens=650000 applied_view=Some(11)`);
    const unchanged = fixture("ride adds no rebuild permission; the current view stays", session);
    const decisions = [request, unchanged].flatMap((line) => parseRunnerDecision(line, session) ?? []);
    const previous = { at: at("14:50:32.000"), model: "claude", read: 650_000, write: 0 };
    const current = { ...previous, at: at("14:50:33.000"), read: 0, write: 430_000 };
    expect(classifyRunnerStep(previous, current, decisions).class).toBe("provider_forgot");
    expect(decisions).toEqual([{ kind: "ride", at: at("14:50:32.940"), detail: "ride [ChainReset], request Some(430000) tokens, last prompt 650000, applied view Some(11)", line: request }]);
});

test("structured signed floor records preserve a quoted parenthetical", () => {
    const line = fixture("signed floor moved; the runner strips signed reasoning at or before it", summarySession);
    const decision = parseRunnerDecision(line, summarySession);
    expect(decision).toMatchObject({ kind: "signed_floor", at: at("14:55:51.432"), line });
    expect(decision?.detail).toContain("g25beebabc1b51255.147323 (not held)");
});

test("structured summary start records the ordinal range and requested tokens", () => {
    const line = fixture("summary started over a message range", summarySession);
    expect(parseRunnerDecision(line, summarySession)).toEqual({ kind: "summary_start", at: at("14:43:17.599"), detail: "summary started over messages 23205..23289 (~27082 tokens)" });
});

test("structured summary publication records count and last ordinal", () => {
    const line = fixture("published summaries", uuid);
    expect(parseRunnerDecision(line, uuid)).toEqual({ kind: "summary_publish", at: at("14:43:47.676"), detail: "1 summaries published, through message 137425" });
});

test("structured no-summary reason can contain spaces, quotes and field-like text", () => {
    const line = fixture("no summary started", summarySession);
    expect(parseRunnerDecision(line, summarySession)).toEqual({ kind: "no_summary", at: at("14:53:25.396"), detail: "no summary at 75% (threshold 75%): nothing to summarize: …" });
    const quoted = structured('no summary started session=s1 usage_pct=76 threshold_pct=75 reason="waiting for \\"session=other\\" (message 42)"');
    expect(parseRunnerDecision(quoted, "s1")?.detail).toContain('waiting for "session=other" (message 42)');
    expect(parseRunnerDecision(quoted, "other")).toBeNull();
});

test("runner head discovery reads structured setup and tracks non-decision activity", () => {
    const { dir, cleanup } = createTestTempDir("runner-log-test-");
    try {
        const path = join(dir, "mixed.log");
        const setup = fixture("setup", head);
        const colon = "alfonso:head:test";
        writeFileSync(path, [
            setup.replace(`session=${head} `, `session=${colon} `),
            setup.replace(`session=${head} `, "session=worker ").replace("preset=head", "preset=worker"),
            `2026-11-26T14:42:33.872Z INFO  magic-context: ck-mc: session: setup done session=${colon} elapsed_ms=1 read_count=0 entry_count=0 applied_view=none late_notice_count=0`,
        ].join("\n"));
        const heads = loadRunnerHeads(dir, at("16:00:00.000"), path);
        expect([...heads.keys()]).toEqual([colon]);
        expect(heads.get(colon)).toMatchObject({ harness: "claude-code", lastLogAt: at("14:42:33.872"), decisions: [{ kind: "setup" }] });
    } finally {
        cleanup();
    }
});

test("the 15:56:51 rewrite is explained by the structured view 56 acceptance", async () => {
    const decision = parseRunnerDecision(fixture("view accepted", rewriteSession), rewriteSession);
    const previousAt = at("15:56:45.602");
    const rewriteAt = at("15:56:51.976");
    const row = (when: number, read: number, write: number): RunnerFeedRow => ({
        cursor: `c${when}`, harness: "claude-code", source: "runner", step_ref: `${rewriteSession}/${when}`,
        session: rewriteSession, occurred_at_ms: when, provider: "anthropic", model: "claude-opus-5-5",
        cache_read: read, cache_write: write, input: 2, output: 1, prompt: read + write + 2, verdict: "warning",
    });
    const rows = await analyzeRunnerFeed({ id: "astrocyte", read: async () => ({
        rows: [row(previousAt, 654_823, 0), row(rewriteAt, 204_520, 62_906)], next: null, through: "end",
    }) }, new Map([[rewriteSession, { harness: "claude-code", decisions: decision ? [decision] : [] }]]), rewriteSession);
    expect(rows[1]?.classification).toMatchObject({
        class: "view", viewVersion: 56, viewAcceptedAt: at("15:56:51.777"), previousStepAt: previousAt, previousTotal: 654_823,
    });
});
