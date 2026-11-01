import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
    renderCompartmentAtTier,
    renderDecayedCompartments,
    type DecayRenderCompartment,
} from "../../../packages/plugin/src/hooks/magic-context/decay-render";
import { estimateTokens } from "../../../packages/plugin/src/hooks/magic-context/read-session-formatting";

type Fixture = { compartments: DecayRenderCompartment[] };

const fixture = JSON.parse(
    readFileSync(new URL("./decay-store-shape.json", import.meta.url), "utf8"),
) as Fixture;
const budgets = [10_500, 19_500, 42_000, 60_000];

function tierCounts(compartments: DecayRenderCompartment[], body: string): number[] {
    const sections = body.length === 0 ? [] : body.split("\n\n");
    const counts = [0, 0, 0, 0, 0];
    for (const compartment of compartments) {
        const heading = `## ${compartment.startMessage}-${compartment.endMessage}`;
        const section = sections.find((part) => part.startsWith(heading));
        let selected = 5;
        for (let tier = 1; tier <= 5; tier++) {
            if (renderCompartmentAtTier(compartment, tier) === section) {
                selected = tier;
                break;
            }
        }
        counts[selected - 1]++;
    }
    return counts;
}

const cases = budgets.map((budget) => {
    const body = renderDecayedCompartments({
        compartments: fixture.compartments,
        historyBudgetTokens: budget,
    });
    return {
        budget,
        tsCost: estimateTokens(body),
        tsTierCounts: tierCounts(fixture.compartments, body),
        bodySha256: createHash("sha256").update(body).digest("hex"),
    };
});

writeFileSync(
    new URL("./decay-store-differential.json", import.meta.url),
    `${JSON.stringify({ cases }, null, 2)}\n`,
);
for (const result of cases) console.log(JSON.stringify(result));
