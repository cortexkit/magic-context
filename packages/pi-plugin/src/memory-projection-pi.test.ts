import { registerNoProposalReviewWitnesses } from "@magic-context/core/shared/memory-no-proposals-review.test";
import {
	type ProjectionDriver,
	type ProjectionFixture,
	type ProjectionOptions,
	projectionModelKey,
	registerMemoryProjectionRegressions,
} from "@magic-context/core/shared/memory-projection-fixtures.test";
import { injectM0M1Pi, materializeM0Pi } from "./inject-compartments-pi";
import { createTestDb } from "./test-utils.test";

function state(
	f: ProjectionFixture,
	sessionId: string,
	render: ProjectionOptions = {},
) {
	return {
		sessionId,
		projectIdentity: f.projectPath,
		projectDirectory: f.directory,
		injectDocs: false,
		injectionBudgetTokens: render.memoryBudget,
		historyBudgetTokens: render.historyBudget,
		hardSignals: {
			systemHash: "system",
			modelKey: projectionModelKey(f, sessionId, render),
			cacheExpired: false,
			lastResponseTime: 1,
		},
	};
}

/** The text of one injected Pi user message. */
function textOf(message: unknown): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part: { type?: string; text?: string }) =>
			part.type === "text" && typeof part.text === "string" ? [part.text] : [],
		)
		.join("");
}

const driver: ProjectionDriver = {
	host: "Pi",
	open: createTestDb,
	hard: (f, sessionId, render) => {
		materializeM0Pi(state(f, sessionId, render), f.db);
	},
	pass: (f, sessionId, busting, render) => {
		const messages: Parameters<typeof injectM0M1Pi>[2] = [];
		const result = injectM0M1Pi(
			state(f, sessionId, render),
			f.db,
			messages,
			undefined,
			busting,
		);
		return {
			m0: textOf(messages[0]),
			m1: textOf(messages[1]),
			materialized: result.m0Materialized,
		};
	},
};

registerMemoryProjectionRegressions(driver);
registerNoProposalReviewWitnesses(driver);
