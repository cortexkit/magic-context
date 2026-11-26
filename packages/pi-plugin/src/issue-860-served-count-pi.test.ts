// Issue 860 on Pi and Oh My Pi: near the limit the emergency drop removes old
// tool output after inferring the part of the request no tool drop can remove
// (the fixed part) as "size of the request minus our count of its active
// tags". The size was the provider's usage reading, in the provider's units;
// every token by which the reading exceeds our count of the same request
// landed in the fixed part, which then exceeded the reduction point and made
// the drop skip with most of the request droppable. The planner now takes the
// smaller of the reading and our own count of the last request served, made
// from the copy of that request the last applied pass captured.
import { afterEach, describe, expect, it } from "bun:test";
import { sessionDecisionCalibration } from "@magic-context/core/features/magic-context/session-decision-calibration";
import {
	calibrationForModelKey,
	providerMass,
} from "@magic-context/core/hooks/magic-context/decision-calibration";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import {
	buildSession,
	CEILING,
	createHarness,
	droppedCalls,
	planLine,
	type Session,
	SYSTEM_PROMPT,
	TOOLS,
} from "./issue-860-served-count-pi-fixture.test";
import { clearPiLkgSessionState } from "./pi-lkg";
import { readPiLkgFitEnvelope } from "./pi-lkg-fit-envelope";
import { countPiLastServedRequest } from "./served-count-pi";
import { tokenizePiMessages } from "./tokenize-pi-messages";

const open: Array<{ close: () => void }> = [];
afterEach(() => {
	for (const harness of open.splice(0)) harness.close();
});

/** Our local count of the whole request: messages, system prompt and tools. */
function localRequestTokens(session: Session) {
	const counts = tokenizePiMessages(session.messages());
	return (
		counts.conversation +
		counts.toolCall +
		estimateTokens(SYSTEM_PROMPT) +
		estimateTokens(JSON.stringify(TOOLS))
	);
}

function envelopeFor(modelKey: string, systemPrompt = SYSTEM_PROMPT) {
	return readPiLkgFitEnvelope(
		{ getSystemPrompt: () => systemPrompt },
		{
			getAllTools: () => TOOLS,
			getActiveTools: () => TOOLS.map((tool) => tool.name),
		},
		modelKey,
		calibrationForModelKey(modelKey),
	);
}

/** The count the planner was given on the last pass, from its log line. */
function servedCount(lines: readonly string[]): number {
	return Number(
		/emergency served count: ≈(\d+)/.exec(lines.join("\n"))?.[1] ?? Number.NaN,
	);
}

/**
 * Our count of the untagged content of a served request, made without the
 * tags: the system prompt and active tools as the envelope sizes them, plus
 * every served message that is not one of the session's own (all of which
 * are tagged), tokenized directly.
 */
function untaggedCount(
	served: readonly unknown[],
	session: Session,
	calibration: Parameters<typeof providerMass>[1],
): number {
	const own = new Set(
		session.messages().map((message) => JSON.stringify(message.content)),
	);
	const untagged = served.filter(
		(message) =>
			!own.has(JSON.stringify((message as { content?: unknown }).content)),
	);
	const envelope = envelopeFor("mock/mock");
	const raw = tokenizePiMessages(untagged as never);
	return providerMass(
		{
			system: envelope?.systemTokens ?? 0,
			tools: (envelope?.refusalToolDefinitionTokens ?? 0) + raw.toolCall,
			prose: raw.conversation,
		},
		calibration,
	);
}

describe("Pi emergency drop: the fixed part is capped by our count of the last request", () => {
	it("a reading twice our count: the release's inferred fixed part is above the ceiling and skips; with the count it drops", async () => {
		const session = buildSession(20);
		const h = createHarness({ sessionId: "pi-860-count", session });
		open.push(h);
		await h.pass(4_000);
		// The provider counts the request twice as high as we do.
		await h.pass(2 * localRequestTokens(session));
		const plan = planLine(h.lines);
		expect(plan?.line).not.toContain("already exceeds ceiling");
		expect(droppedCalls(h.statuses()).length).toBeGreaterThan(0);
		expect(plan?.line).toContain("floor from our count");
		expect(plan?.floor ?? Infinity).toBeLessThan(CEILING / 2);
		expect(servedCount(h.lines)).toBeGreaterThan(0);
	});

	it("pin: with no saved copy of the last request the plan is the release's: the inferred fixed part, the skip, nothing dropped", async () => {
		const sessionId = "pi-860-no-copy";
		const session = buildSession(20);
		const h = createHarness({ sessionId, session });
		open.push(h);
		await h.pass(4_000);
		// As after a restart: the process holds no copy of the last request.
		clearPiLkgSessionState(sessionId);
		await h.pass(2 * localRequestTokens(session));
		const plan = planLine(h.lines);
		expect(plan?.line).toContain("already exceeds ceiling");
		expect(plan?.line).not.toContain("floor from our count");
		expect(droppedCalls(h.statuses())).toEqual([]);
		expect(h.lines.join("\n")).toContain(
			"emergency served count unavailable: no saved copy of the last request served",
		);
	});

	it("a count is made only for the model and the system prompt and tools the saved request was sent with", async () => {
		const sessionId = "pi-860-other-model";
		const h = createHarness({ sessionId, session: buildSession(6) });
		open.push(h);
		await h.pass(4_000);
		const count = (modelKey: string, systemPrompt?: string) =>
			countPiLastServedRequest({
				sessionId,
				envelope: envelopeFor(modelKey, systemPrompt),
				calibration: { systemRatio: 1, toolsRatio: 1, proseRatio: 1 },
				recovery: false,
			});
		expect(count("mock/mock")).toEqual({ tokens: expect.any(Number) });
		expect(count("anthropic/claude-sonnet-5")).toEqual({
			unavailable: "the saved request was served to another model",
		});
		expect(count("mock/mock", `${SYSTEM_PROMPT}One more rule.\n`)).toEqual({
			unavailable:
				"the system prompt or tools changed since the saved request was served",
		});
	});

	it("our count of the saved request minus our count of its active tags matches an independent count of its untagged content", async () => {
		const sessionId = "pi-860-count-agrees";
		const session = buildSession(20);
		const h = createHarness({ sessionId, session, injection: true });
		open.push(h);
		// A summary covers the first steps, so the served request carries a
		// history head and starts after the cut.
		h.publishThrough("r-3");
		const served = await h.pass(4_000);
		h.lines.length = 0;
		await h.pass(2 * localRequestTokens(session));
		const count = servedCount(h.lines);
		const plan = planLine(h.lines);
		expect(plan?.line).toContain("floor from our count");
		// Nothing was removed before the planner, and only the last assistant
		// reply and the user message after it (a few tokens) are newer than the
		// reading, so the floor is the count minus our count of the active tags.
		const countMinusTags = plan?.floor ?? Number.NaN;
		const independent = untaggedCount(
			served,
			session,
			sessionDecisionCalibration(h.db, sessionId),
		);
		const difference = (countMinusTags - independent) / count;
		console.log(
			`COUNT_AND_TAGS count=${count} countMinusTags=${Math.round(countMinusTags)} independentUntagged=${independent} difference=${(difference * 100).toFixed(2)}% of the request`,
		);
		expect(Math.abs(difference)).toBeLessThanOrEqual(0.05);
	});

	it("tags the reading counts as newer but the saved request already holds are left out of the subtraction: the fixed part rises by their mass, towards the release's", async () => {
		const sessionId = "pi-860-newer-held";
		// Ending on a tool result: the last call and its result come after the
		// last assistant message the reading can have measured.
		const session = buildSession(22, { endWithToolResult: true });
		const h = createHarness({ sessionId, session });
		open.push(h);
		const served = await h.pass(4_000);
		h.lines.length = 0;
		const reading = 2 * localRequestTokens(session);
		await h.pass(reading);
		const count = servedCount(h.lines);
		const plan = planLine(h.lines);
		expect(plan?.line).toContain("floor from our count");
		const newer = Number(
			/≈(\d+) newer than the reading/.exec(plan?.line ?? "")?.[1],
		);
		expect(newer).toBeGreaterThan(500);
		const floor = plan?.floor ?? Number.NaN;
		const untagged = untaggedCount(
			served,
			session,
			sessionDecisionCalibration(h.db, sessionId),
		);
		// The saved request holds the newer tags, so the count includes them,
		// but they are not subtracted: the floor exceeds the untagged content by
		// about their mass.
		const olderTags = count - untagged - newer;
		const releaseFloor = reading - olderTags;
		console.log(
			`NEWER_HELD count=${count} newer=${newer} untagged=${untagged} floor=${Math.round(floor)} releaseFloor≈${Math.round(releaseFloor)} reading=${reading}`,
		);
		expect(Math.abs(floor - untagged - newer)).toBeLessThanOrEqual(
			0.05 * count,
		);
		// Still far below the release's inferred floor.
		expect(floor).toBeLessThan(releaseFloor);
	});
});
