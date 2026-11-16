// Drive the deterministic mural pipeline (resolve → gate → render) against the
// live context.db for one or more project identities, without touching the
// running plugin process. Writes PNGs next to this script's output dir and
// reports dimensions, token cost, and gate decisions so renderer changes can be
// verified on real pools before any restart picks them up organically.
//
// Usage: bun packages/plugin/scripts/test-mural-render.ts [projectIdentity ...]
// With no args, tests every project that has at least one active memory cue
// plus the projects present in mural_manifest (so gate-skips are visible too).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { openDatabase } from "../src/features/magic-context/storage";
import { getMuralCoverage, resolveMural } from "../src/features/magic-context/mural/resolve-mural";
import { muralCoverageGate } from "../src/features/magic-context/mural/render-trigger";
import {
    muralImageTokenEstimateForDimensions,
    renderMural,
} from "../src/features/magic-context/mural/render-mural";

const outDir = join(import.meta.dir, "mural-test-output");
mkdirSync(outDir, { recursive: true });

const db = openDatabase();
if (!db) {
    console.error("test-mural-render: could not open context.db");
    process.exit(1);
}
const requested = process.argv.slice(2);
const identities =
    requested.length > 0
        ? requested
        : (
              db
                  .prepare(
                      `SELECT DISTINCT project_path FROM memories
                       WHERE status='active' AND mural_cue IS NOT NULL AND mural_cue != ''
                       UNION SELECT project_path FROM mural_manifest`,
                  )
                  .all() as { project_path: string }[]
          ).map((row) => row.project_path);

for (const identity of identities) {
    const coverage = getMuralCoverage(db, identity);
    const gatePassed = muralCoverageGate(coverage.cuedMemoryCount, coverage.activeMemoryCount);
    const header = `${identity} · active=${coverage.activeMemoryCount} cued=${coverage.cuedMemoryCount} undrawable=${coverage.undrawableCueCount}`;
    if (!gatePassed) {
        console.log(`${header} → GATE SKIP (needs >=15 drawable cues or >=50% coverage)`);
        continue;
    }
    const entries = resolveMural(db, identity);
    if (entries.length === 0) {
        // Mirrors ensureMuralRendered: every memory fits the m0 budget, so there
        // is no overflow to visualize and production emits no mural block.
        console.log(`${header} → NO MURAL (overflow pool empty; all memories fit the m0 budget)`);
        continue;
    }
    const result = renderMural(entries);
    if (result.renderedIds.length === 0) {
        // Mirrors ensureMuralRendered: no overflow cue can be drawn by the font, so
        // production sends no image.
        console.log(
            `${header} → NO MURAL (none of ${entries.length} overflow cues is drawable; undrawable=${result.undrawableIds.length})`,
        );
        continue;
    }
    const tokens = muralImageTokenEstimateForDimensions(result.width, result.height);
    const file = join(outDir, `${identity.replace(/[^a-z0-9]/gi, "_").slice(0, 60)}.png`);
    writeFileSync(file, result.png);
    console.log(
        `${header} → ${result.width}x${result.height} · ${tokens} tokens · rendered=${result.renderedIds.length} dropped=${result.droppedIds.length} undrawable=${result.undrawableIds.length} · ${file}`,
    );
}
