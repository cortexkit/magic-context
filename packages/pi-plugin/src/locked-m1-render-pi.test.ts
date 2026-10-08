import {
	createLockedDeltaFixture,
	type LockedDeltaFixture,
	type LockedDeltaOptions,
	registerLockedDeltaRegressions,
} from "@magic-context/core/shared/fold-render-lock-fixtures.test";
import {
	injectM0M1Pi,
	materializeM0Pi,
	renderM1Pi,
} from "./inject-compartments-pi";
import { createTestDb } from "./test-utils.test";

function state(f: LockedDeltaFixture, render: LockedDeltaOptions) {
	return {
		sessionId: f.sessionId,
		projectIdentity: f.projectPath,
		projectDirectory: f.directory,
		injectDocs: false,
		injectionBudgetTokens: render.memoryBudget,
	};
}
registerLockedDeltaRegressions({
	host: "Pi",
	create: (label) => createLockedDeltaFixture(label, createTestDb),
	materialize: (f, render) =>
		materializeM0Pi(state(f, render), f.db).snapshotMarkers,
	refresh: (f, render, beforeCacheCommitForTest) => {
		injectM0M1Pi(
			{ ...state(f, render), beforeCacheCommitForTest },
			f.db,
			[],
			undefined,
			true,
		);
	},
	render: (f, render, markers) =>
		renderM1Pi(state(f, render), f.db, markers, []),
});
