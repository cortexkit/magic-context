import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runHeuristicCostFixture } from "../src/__tests__/heuristic-cost-fixture";

const { wire, tagState, replayDocument, ...report } = runHeuristicCostFixture();
writeFileSync(join(report.root, "served.json"), wire);
writeFileSync(join(report.root, "tags.json"), tagState);
writeFileSync(join(report.root, "replay.json"), replayDocument);
writeFileSync(join(report.root, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ bun: Bun.version, ...report }, null, 2));
