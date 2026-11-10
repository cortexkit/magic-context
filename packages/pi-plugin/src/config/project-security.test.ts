import { describe, expect, it } from "bun:test";

import { stripUnsafeProjectConfigFields } from "@magic-context/core/config/project-security";

describe("Pi project config security", () => {
	it("strips language from project config", () => {
		const raw: Record<string, unknown> = {
			language: "tr",
			dreamer: { model: "x" },
		};
		const warnings = stripUnsafeProjectConfigFields(raw);

		expect(raw.language).toBeUndefined();
		expect(raw.dreamer).toEqual({ model: "x" });
		expect(warnings.join("\n")).toContain(
			"Ignoring language from project config",
		);
	});

	it("strips fail_closed_blocking from project config", () => {
		const raw: Record<string, unknown> = {
			fail_closed_blocking: false,
			dreamer: { model: "x" },
		};
		const warnings = stripUnsafeProjectConfigFields(raw);

		expect(raw.fail_closed_blocking).toBeUndefined();
		expect(raw.dreamer).toEqual({ model: "x" });
		expect(warnings.join("\n")).toContain("fail_closed_blocking");
	});

	it("strips compaction.enabled from project config (only-key case)", () => {
		const raw: Record<string, unknown> = {
			compaction: { enabled: false },
			dreamer: { model: "x" },
		};
		const warnings = stripUnsafeProjectConfigFields(raw);
		const compaction = raw.compaction as Record<string, unknown>;

		expect("enabled" in compaction).toBe(false);
		expect(raw.compaction).toEqual({});
		expect(raw.dreamer).toEqual({ model: "x" });
		expect(warnings.join("\n")).toContain("compaction.enabled");
	});

	it("strips compaction.enabled but keeps a sibling key (field-scoped)", () => {
		const raw: Record<string, unknown> = {
			compaction: { enabled: false, futureSibling: 1 },
		};
		const warnings = stripUnsafeProjectConfigFields(raw);
		const compaction = raw.compaction as Record<string, unknown>;

		expect("enabled" in compaction).toBe(false);
		expect(compaction.futureSibling).toBe(1);
		expect(warnings.join("\n")).toContain("compaction.enabled");
	});

	it("strips embedding.dimensions from project config (user-tier only)", () => {
		const raw: Record<string, unknown> = {
			embedding: { dimensions: 4096 },
			dreamer: { model: "x" },
		};
		const warnings = stripUnsafeProjectConfigFields(raw);

		const embedding = raw.embedding as Record<string, unknown> | undefined;
		expect(embedding === undefined || !("dimensions" in embedding)).toBe(true);
		expect(raw.dreamer).toEqual({ model: "x" });
		expect(warnings.join("\n")).toContain("dimensions");
	});
});
