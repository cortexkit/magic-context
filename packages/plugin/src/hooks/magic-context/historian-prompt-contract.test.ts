import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildHiddenAgentRegistrations } from "../../agents/hidden-agent-registrations";
import {
    DREAMER_SYSTEM_PROMPT,
    FRICTION_GATE_SYSTEM_PROMPT,
    RETROSPECTIVE_SYSTEM_PROMPT,
} from "../../features/magic-context/dreamer/task-prompts";
import {
    buildTurnTwoPrompt,
    parseTurnTwoEnvelope,
} from "../../features/magic-context/memory/turn-two-envelope";
import { COMPRESS_CUES_SYSTEM_PROMPT } from "../../features/magic-context/mural/compress-cues-prompt";
import {
    COMPARTMENT_AGENT_SYSTEM_PROMPT,
    COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT,
    historianSystemPrompt,
} from "./compartment-prompt";
import { COMPARTMENT_AGENT_COMBINED_SYSTEM_PROMPT } from "./historian-prompt.generated";
import { renderHistorianSystemPrompt } from "./historian-prompt-render";
import { isMagicContextInternalAgent } from "./system-prompt-hash";
import { TWO_PASS_SYSTEM, TWO_PASS_TURN_TWO } from "./two-pass-prompts/prompts.generated";

const source = readFileSync(new URL("./historian-prompt.source.md", import.meta.url), "utf8");
const xml = renderHistorianSystemPrompt(source, "xml");
const combined = renderHistorianSystemPrompt(source, "combined");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("generated XML and combined artifacts are byte-identical across TypeScript and Rust", () => {
    for (const [rendered, generated, artifact, enabled] of [
        [xml, COMPARTMENT_AGENT_SYSTEM_PROMPT, "historian-system-prompt.txt", false],
        [
            combined,
            COMPARTMENT_AGENT_COMBINED_SYSTEM_PROMPT,
            "historian-system-prompt-combined.txt",
            true,
        ],
    ] as const) {
        expect(Buffer.from(generated)).toEqual(Buffer.from(rendered));
        expect(
            readFileSync(
                new URL(`../../../../../crates/mc-module/testdata/${artifact}`, import.meta.url),
            ),
        ).toEqual(Buffer.from(generated));
        expect(historianSystemPrompt(enabled)).toBe(enabled ? TWO_PASS_SYSTEM : generated);
    }
    expect(hash(COMPARTMENT_AGENT_SYSTEM_PROMPT)).not.toBe(
        hash(COMPARTMENT_AGENT_COMBINED_SYSTEM_PROMPT),
    );
});

test("combined contract retains turn-one prose and specifies both steps", () => {
    expect(combined.split("## Output")[0]).toBe(xml.split("## Output")[0]);
    expect(combined).toContain('{"result":{"step":"turn_one","xml":"..."}}');
    expect(combined).toContain('{"result":{"step":"turn_two","decisions":[...],"scores":[...]}}');
    expect(combined).toContain("the historian prose above remains in force on turn two");
    expect(xml).toContain("Output valid XML only in this shape:");
    expect(xml).not.toContain('"step":"turn_two"');
    expect(hash(xml)).not.toBe(hash(combined));
    expect(xml).not.toContain("<!-- historian:");
    expect(combined).not.toContain("<!-- historian:");
});

test("turn-two user content carries notices and data, not a second format schema", () => {
    const prompt = buildTurnTwoPrompt({
        lexicalOnly: true,
        deferred: { facts: 2, items: 1 },
        facts: [
            {
                factId: 4,
                category: "PROJECT_RULES",
                content: "Keep a backup.",
                sourceSessionId: "source",
                anchorKnown: false,
                blocks: [],
                neighbours: [],
                backlog: false,
            },
        ],
        items: [{ item: 5, memoryId: 8, content: "Preserve data.", excerpt: "Save first." }],
    });
    expect(prompt).toContain("## Fact 4");
    expect(prompt).toContain("## Agent memories to score");
    expect(prompt).toContain("Save first.");
    expect(prompt).toContain("allowed_fact_ids: [4]");
    expect(prompt).toContain(TWO_PASS_TURN_TWO.replace("{{ALLOWED_FACT_IDS}}", "[4]"));
    // The turn-two instructions name `final_text` once for the accepted-decision
    // `Decided:` rule; the full per-action field schema still lives only in the
    // system prompt, which these tokens guard against duplicating here.
    for (const format of ["Reply with", "JSON", "target_id", "1-100", "decay class"])
        expect(prompt).not.toContain(format);
});

test("a proposed decay class stays a free string with no taxonomy", () => {
    expect(combined).toContain("a free nonempty string of at most 64 characters");
    const result = parseTurnTwoEnvelope(
        JSON.stringify({
            result: {
                step: "turn_two",
                decisions: [],
                scores: [{ item: 7, importance: 40, class: "an entirely new class" }],
            },
        }),
        false,
    );
    expect(result.ok).toBe(true);
    if (result.ok)
        expect(result.scores).toEqual([
            { item: 7, importance: 40, proposedClass: "an entirely new class" },
        ]);
});

test("dormant historian preserves the placed-window one-pass system bytes", () => {
    // Pin the existing XML contract independently of the generator: enabling a new
    // optional lane must not silently change the prompt of sessions that stay off.
    expect(hash(historianSystemPrompt(false))).toBe(
        "590649b1f6b2428940cb925586342be58bdecc3ee4d64153d2f73ec5251532bd",
    );
    expect(hash(xml)).toBe(hash(historianSystemPrompt(false)));
});

test("detection relies on the unchanged dreamer registration, not reworded tasks", () => {
    for (const [prompt, digest] of [
        [
            FRICTION_GATE_SYSTEM_PROMPT,
            "071b13b154610b1267176fd25b0e9cb76cb0aaa238491e28f1b16c0379f71286",
        ],
        [
            RETROSPECTIVE_SYSTEM_PROMPT,
            "42883574843ef1c1ac7651cb2753200fa771e240ade20786dceb0274639ffc23",
        ],
        [
            COMPRESS_CUES_SYSTEM_PROMPT,
            "b3169cfae83d07a312b8d59fa402ec02b873c75182a71ccea325fef944ed56f0",
        ],
    ])
        expect(hash(prompt)).toBe(digest);
    expect(hash(DREAMER_SYSTEM_PROMPT)).toBe(
        "190e22ed2f0c3734efe7c82e8f1fa05889cc3629e8571c0d1ab6f65221585fe1",
    );
    expect(DREAMER_SYSTEM_PROMPT).toContain("for the magic-context system");
    const registrations = buildHiddenAgentRegistrations({
        dreamerPrompt: DREAMER_SYSTEM_PROMPT,
        historianPrompt: xml,
        historianEditorPrompt: "unused",
        historianDisallowed: [],
    });
    for (const id of ["dreamer-retrospective", "dreamer-classifier"]) {
        const registration = registrations.find((entry) => entry.id === id);
        expect(registration?.prompt).toBe(DREAMER_SYSTEM_PROMPT);
        expect(isMagicContextInternalAgent(registration!.prompt!)).toBe(true);
    }
});

test("every historian rendering preserves the exact persona sentence", () => {
    const persona = "You are Historian — the hippocampus of a long-running coding agent.";
    for (const prompt of [xml, combined, COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT]) {
        expect(prompt).toContain(persona);
        expect(isMagicContextInternalAgent(prompt)).toBe(true);
    }
});
