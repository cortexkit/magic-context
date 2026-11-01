import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

import {
    renderCompartmentAtTier,
    renderDecayedCompartments,
    type DecayRenderCompartment,
} from "../../../packages/plugin/src/hooks/magic-context/decay-render";
import { estimateTokens } from "../../../packages/plugin/src/hooks/magic-context/read-session-formatting";

const budget = 20;
const compartments: DecayRenderCompartment[] = Array.from({ length: 40 }, (_, index) => {
    const sequence = index + 1;
    return {
        startMessage: sequence,
        endMessage: sequence,
        title: `Pressure ${sequence}`,
        content: `legacy ${sequence}`,
        p1: `P1 ${sequence} ${"full ".repeat(40)}`,
        p2: `P2 ${sequence} ${"medium ".repeat(12)}`,
        p3: `P3 ${sequence} ${"brief ".repeat(4)}`,
        p4: `P4 ${sequence}`,
        importance: 50,
        legacy: 0,
    };
});

function renderM0History(multiplier: number): string {
    const body = renderDecayedCompartments({
        compartments,
        historyBudgetTokens: budget / Math.max(1, multiplier),
    });
    return body.length > 0
        ? `<session-history>\n${body}\n</session-history>`
        : "<session-history></session-history>";
}

function tierCounts(m0History: string): number[] {
    const body = m0History
        .replace(/^<session-history>\n?/, "")
        .replace(/\n?<\/session-history>$/, "");
    const sections = body.length === 0 ? [] : body.split("\n\n");
    const counts = [0, 0, 0, 0, 0];
    for (const compartment of compartments) {
        const heading = `## ${compartment.startMessage}-${compartment.endMessage}`;
        const section = sections.find((candidate) => candidate.startsWith(heading));
        let tier = 5;
        for (let candidate = 1; candidate <= 5; candidate++) {
            if (renderCompartmentAtTier(compartment, candidate) === section) {
                tier = candidate;
                break;
            }
        }
        counts[tier - 1]++;
    }
    return counts;
}

let multiplier = 1;
let attempts = 0;
let m0History = renderM0History(multiplier);
while (budget > 0 && estimateTokens(m0History) > budget * 1.05 && attempts < 3) {
    multiplier *= 1.15;
    m0History = renderM0History(multiplier);
    attempts++;
}

writeFileSync(
    new URL("./m0-decay-pressure-retry.json", import.meta.url),
    `${JSON.stringify(
        {
            provenance:
                "TS shared decay renderer; no sibling m0 blocks, so this is the complete <session-history> slice measured by the materializer",
            budget,
            attempts,
            tier_counts: tierCounts(m0History),
            m0_sha256: createHash("sha256").update(m0History).digest("hex"),
        },
        null,
        2,
    )}\n`,
);
