import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import {
    createLockedDeltaFixture,
    type LockedDeltaFixture,
    type LockedDeltaOptions,
    registerLockedDeltaRegressions,
} from "../../shared/fold-render-lock-fixtures.test";
import { injectM0M1, materializeM0, renderM1 } from "./inject-compartments";

function options(f: LockedDeltaFixture, render: LockedDeltaOptions) {
    return {
        db: f.db,
        state: getOrCreateSessionMeta(f.db, f.sessionId),
        sessionId: f.sessionId,
        projectPath: f.projectPath,
        projectDirectory: f.directory,
        injectDocs: false,
        memoryInjectionBudgetTokens: render.memoryBudget,
        temporalAwareness: render.temporalAwareness,
    };
}
registerLockedDeltaRegressions({
    host: "OpenCode",
    create: createLockedDeltaFixture,
    materialize: (f, render) =>
        materializeM0({ ...options(f, render), state: getOrCreateSessionMeta(f.db, f.sessionId) })
            .snapshotMarkers,
    refresh: (f, render, beforeCacheCommitForTest) => {
        injectM0M1({
            ...options(f, render),
            state: getOrCreateSessionMeta(f.db, f.sessionId),
            isCacheBustingPass: true,
            beforeCacheCommitForTest,
        });
    },
    render: (f, render, markers) => renderM1(options(f, render), markers, []),
    temporalHeadings: true,
});
