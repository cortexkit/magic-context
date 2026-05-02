import { describe, expect, it } from "bun:test";
import { injectPiTemporalMarkers } from "./temporal-awareness-pi";

describe("injectPiTemporalMarkers", () => {
	it("injects a +12m marker when user message arrives 12 minutes after previous", () => {
		const t0 = 1_700_000_000_000;
		const messages = [
			{ role: "user", content: "First", timestamp: t0 },
			{ role: "assistant", content: [], timestamp: t0 + 1_000 },
			{
				role: "user",
				content: "Second",
				timestamp: t0 + 12 * 60 * 1000 + 5_000,
			},
		];
		const injected = injectPiTemporalMarkers(messages);
		expect(injected).toBe(1);
		expect(messages[2]).toMatchObject({
			role: "user",
			content: "<!-- +12m -->\nSecond",
		});
	});

	it("does NOT inject for gaps below the 5-minute threshold", () => {
		const t0 = 1_700_000_000_000;
		const messages = [
			{ role: "user", content: "First", timestamp: t0 },
			{
				role: "user",
				content: "Quick follow-up",
				timestamp: t0 + 60 * 1000, // 1 minute
			},
		];
		expect(injectPiTemporalMarkers(messages)).toBe(0);
		expect(messages[1]).toMatchObject({ content: "Quick follow-up" });
	});

	it("formats long gaps with hours and days", () => {
		const t0 = 1_700_000_000_000;
		const messages = [
			{ role: "assistant", content: [], timestamp: t0 },
			{
				role: "user",
				content: "Back",
				timestamp: t0 + (3 * 24 + 4) * 60 * 60 * 1000, // 3d 4h
			},
		];
		expect(injectPiTemporalMarkers(messages)).toBe(1);
		expect(messages[1]).toMatchObject({ content: "<!-- +3d 4h -->\nBack" });
	});

	it("is idempotent — re-injecting on the same array does not double-prefix", () => {
		const t0 = 1_700_000_000_000;
		const messages = [
			{ role: "user", content: "First", timestamp: t0 },
			{
				role: "user",
				content: "Later",
				timestamp: t0 + 10 * 60 * 1000,
			},
		];
		expect(injectPiTemporalMarkers(messages)).toBe(1);
		expect(injectPiTemporalMarkers(messages)).toBe(0);
		expect(messages[1]).toMatchObject({ content: "<!-- +10m -->\nLater" });
	});

	it("inserts the marker AFTER any §N§ tag prefix so re-tagging stays idempotent", () => {
		const t0 = 1_700_000_000_000;
		const messages = [
			{ role: "user", content: "First", timestamp: t0 },
			{
				role: "user",
				content: "§42§ Tagged user message",
				timestamp: t0 + 10 * 60 * 1000,
			},
		];
		expect(injectPiTemporalMarkers(messages)).toBe(1);
		expect(messages[1]).toMatchObject({
			content: "§42§ <!-- +10m -->\nTagged user message",
		});
	});

	it("works on array-shaped user content (TextContent[])", () => {
		const t0 = 1_700_000_000_000;
		const messages = [
			{
				role: "user",
				content: [{ type: "text", text: "First" }],
				timestamp: t0,
			},
			{
				role: "user",
				content: [{ type: "text", text: "Later" }],
				timestamp: t0 + 10 * 60 * 1000,
			},
		];
		expect(injectPiTemporalMarkers(messages)).toBe(1);
		const second = messages[1] as { content: Array<{ text: string }> };
		expect(second.content[0].text).toBe("<!-- +10m -->\nLater");
	});

	it("does NOT inject markers on assistant messages", () => {
		const t0 = 1_700_000_000_000;
		const messages = [
			{ role: "user", content: "First", timestamp: t0 },
			{
				role: "assistant",
				content: [{ type: "text", text: "Reply" }],
				timestamp: t0 + 10 * 60 * 1000,
			},
		];
		expect(injectPiTemporalMarkers(messages)).toBe(0);
		expect(
			(messages[1] as { content: Array<{ text: string }> }).content[0].text,
		).toBe("Reply");
	});

	it("returns 0 when timestamps are missing on either side", () => {
		const messages = [
			{ role: "user", content: "First" }, // no timestamp
			{
				role: "user",
				content: "Second",
				timestamp: 1_700_000_000_000,
			},
		];
		expect(injectPiTemporalMarkers(messages)).toBe(0);
	});
});
