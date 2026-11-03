import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lifecycleTextHash } from "../../src/features/magic-context/memory/lifecycle-text";
import {
    type CorpusManifest,
    GEMINI_MODEL,
    keptInputBound,
    omissionsFailures,
    printedBlocks,
    productionTurnOne,
    readCorpusFile,
    requireStart,
    startFailures,
    turnOneAnchorFailures,
} from "./core";

const sha = lifecycleTextHash("fixture");
const file = { path: "frozen.json", sha256: sha };
const firstFile = { path: "first.json", sha256: sha };
const texts = Array.from({ length: 13 }, (_, index) => `Fixture fact ${index + 1}.`);
const hashes = texts.map(lifecycleTextHash);
const first = `<facts><PROJECT_RULES>\n${texts.map((text) => `* ${text}`).join("\n")}\n</PROJECT_RULES></facts>`;
const frozen = {
    firstReplyHash: lifecycleTextHash(first),
    facts: texts.map((content) => ({ category: "PROJECT_RULES", content })),
    origins: texts.map(() => "reply"),
    matches: texts.map(() => [{ id: 1, content: "Old fact." }]),
    input: { prompt: "<new_messages>\n[10] fixture\n</new_messages>" },
};
const fixtureRead = (record: { path: string }) =>
    record.path === "first.json"
        ? JSON.stringify({ request: { messages: [{ role: "assistant", content: first }] } })
        : JSON.stringify(frozen);
function manifest(): CorpusManifest {
    return {
        version: 1,
        corpusRoot: "private",
        durablePrivateCopyConfirmed: true,
        models: { gemini: GEMINI_MODEL, deepseek: "test/owner-selected-literal" },
        cases: Array.from({ length: 40 }, (_, index) => ({
            id: index,
            input: file,
            firstReply: firstFile,
            candidates: file,
            frozen: file,
            records: [],
            blocks: printedBlocks(frozen.input.prompt).map((block) => ({
                start: block.startOrdinal,
                end: block.endOrdinal,
                sha256: lifecycleTextHash(block.joinedText),
            })),
            facts: Array.from({ length: 13 }, (_, i) => ({
                id: i + 1,
                contentHash: hashes[i]!,
                origin: "reply" as const,
                anchor: { start: 10, end: 10 },
            })),
            replyFactHashes: hashes,
            keptCheckInputUnits: keptInputBound(frozen),
        })),
        evidence: [],
    };
}

describe("replay start fence", () => {
    test("private corpus hashes are checked against actual bytes and paths cannot escape", () => {
        const root = mkdtempSync(join(tmpdir(), "memory-replay-"));
        try {
            writeFileSync(join(root, "fixture.txt"), "frozen bytes");
            expect(
                readCorpusFile(root, {
                    path: "fixture.txt",
                    sha256: lifecycleTextHash("frozen bytes"),
                }),
            ).toBe("frozen bytes");
            expect(() => readCorpusFile(root, { path: "fixture.txt", sha256: sha })).toThrow(
                "Corpus hash mismatch",
            );
            expect(() =>
                readCorpusFile(root, {
                    path: join(root, "fixture.txt"),
                    sha256: lifecycleTextHash("frozen bytes"),
                }),
            ).toThrow("Corpus path escapes private root");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    test("complete private corpus starts; missing owner model never starts", () => {
        const input = manifest();
        expect(requireStart(input, fixtureRead)).toEqual(input);
        input.models.deepseek = null;
        expect(() => requireStart(input, fixtureRead)).toThrow(
            "owner_literal_deepseek_model_missing",
        );
        input.models.deepseek = "${DEEPSEEK_MODEL}";
        expect(() => requireStart(input, fixtureRead)).toThrow("manifest_schema");
    });
    test("every named start condition fails closed", () => {
        const input = manifest();
        input.durablePrivateCopyConfirmed = false;
        input.cases[0]!.facts[0]!.anchor = null;
        input.cases[2]!.keptCheckInputUnits = 48_001;
        input.cases[12]!.facts = input.cases[12]!.facts.slice(0, 9);
        input.cases[27]!.replyFactHashes = [];
        const failures = startFailures(input, fixtureRead).join("\n");
        expect(failures).toContain("durable_private_corpus_unconfirmed");
        expect(failures).toContain("0:1: recorded_source_block_anchor_missing");
        expect(failures).toContain("2: problem_kept_check_input_unproven_or_oversize");
        expect(failures).toContain("12:10: control_candidate_missing");
        expect(failures).toContain("27: frozen_reply_fact_mapping_missing");
        expect(
            startFailures(manifest(), () => {
                throw new Error("missing corpus file");
            }),
        ).toContain("Error: missing corpus file");
    });
});

const compartment =
    '<compartment start="10" end="11" title="Test" importance="50"><p1>Test</p1><p2>Test</p2><p3>Test</p3><p4>Test</p4></compartment>';
const reply = (anchor: string, tail = "") =>
    `<output><compartments>${compartment}</compartments><facts><PROJECT_RULES>\n* ${anchor} Preserve limits.\n</PROJECT_RULES></facts>${tail}</output>`;
describe("production turn one", () => {
    test("prompt uses production anchor instruction without project memory", () => {
        const prompt = productionTurnOne({
            seedExamples: "",
            sessionReferences: "",
            projectMemory: "SECRET MEMORY",
            inputSource: "[10] user: Keep limits.",
        });
        expect(prompt).not.toContain("SECRET MEMORY");
        expect(prompt).toContain("at_compartment");
        expect(prompt).toContain("<new_messages>");
    });
    test("only reply-local printed ranges or explicit unknown anchors pass", () => {
        expect(
            turnOneAnchorFailures(
                reply("[at_compartment=1 messages=10]"),
                "[10] user: one\n[11] assistant: two",
            ),
        ).toEqual([]);
        expect(
            turnOneAnchorFailures(
                reply("[at_compartment=1 messages=10-11]"),
                "[10] user: one\n[11] assistant: two",
            ),
        ).toEqual(["fact_1: anchor_not_reply_local_printed_range"]);
        expect(
            turnOneAnchorFailures(
                reply(
                    "[at_compartment=1 messages=10-11]",
                    "<unprocessed_from>12</unprocessed_from>",
                ),
                "[10] user: one\n[11] assistant: two\n[12] user: lookahead",
            ),
        ).toEqual([]);
        expect(turnOneAnchorFailures(reply("[at_compartment=unknown]"), "[10] user: one")).toEqual(
            [],
        );
        for (const prefix of [
            "",
            "[at_compartment=2 messages=10]",
            "[at_compartment=1]",
            "[at_compartment=1 messages=10-12]",
            "[at_compartment=garbage]",
        ]) {
            expect(turnOneAnchorFailures(reply(prefix), "[10] user: one").length).toBeGreaterThan(
                0,
            );
        }
        expect(
            turnOneAnchorFailures(
                reply("[at_compartment=1 messages=10]", "<unprocessed_from>10</unprocessed_from>"),
                "[10] user: one",
            ).length,
        ).toBeGreaterThan(0);
    });
    test("multi-range and folded-line anchors retain every printed-boundary and containment check", () => {
        const localReply = (anchor: string) => reply(anchor).replace('end="11"', 'end="13"');
        const printed =
            "[10] user: one\n[11] assistant: two\n[12] user: three\n[13] assistant: four\n[14] user: lookahead";
        expect(
            turnOneAnchorFailures(localReply("[at_compartment=1 messages=10,12]"), printed),
        ).toEqual([]);
        expect(
            turnOneAnchorFailures(localReply("[at_compartment=1 messages=10,14]"), printed),
        ).toEqual(["fact_1: anchor_not_reply_local_printed_range"]);
        expect(
            turnOneAnchorFailures(localReply("[at_compartment=1 messages=10,12,13,14]"), printed),
        ).toEqual(["fact_1: anchor_not_reply_local_printed_range"]);
        const folded = "[10-11] user: one\n[12] assistant: two\n[13] user: three";
        expect(
            turnOneAnchorFailures(localReply("[at_compartment=1 messages=10-11]"), folded),
        ).toEqual([]);
        expect(turnOneAnchorFailures(localReply("[at_compartment=1 messages=10]"), folded)).toEqual(
            ["fact_1: anchor_not_reply_local_printed_range"],
        );
        expect(
            turnOneAnchorFailures(
                localReply("[at_compartment=1 messages=10,12]"),
                "[10] user: one\n[11] assistant: two\n[13] user: three",
            ),
        ).toEqual(["fact_1: anchor_not_reply_local_printed_range"]);
    });
});

function ledger() {
    return {
        corpusManifestHash: sha,
        extractor: "model-a",
        reviewer: "independent-human",
        families: [
            {
                caseId: 1,
                family: "refusal code",
                safetyShaped: true,
                missedBy: ["new"],
                new: "already-covered",
                S: "duplicate",
            },
        ],
    };
}
describe("independent omissions ledger", () => {
    test("complete paired grades pass and missing either arm fails closed", () => {
        expect(omissionsFailures(ledger(), sha, ["1:refusal code"])).toEqual([]);
        for (const arm of ["new", "S"]) {
            const input = { ...ledger(), families: [{ ...ledger().families[0], [arm]: null }] };
            expect(omissionsFailures(input, sha, ["1:refusal code"])).toContain(
                "1:refusal code: both_arm_grades_required",
            );
        }
        expect(omissionsFailures(null, sha, ["1:refusal code"])).toEqual([
            "omissions_ledger_missing_or_malformed",
        ]);
    });
    test("safety loss, per-case loss excess and non-independent or incomplete inventory fail", () => {
        const input = ledger();
        input.families[0]!.new = "loss";
        expect(omissionsFailures(input, sha, ["1:refusal code"])).toEqual([
            "1:refusal code: safety_rule_loss",
            "1: new_losses_exceed_S",
        ]);
        input.reviewer = input.extractor;
        expect(omissionsFailures(input, sha, ["1:refusal code", "2:missing family"])).toContain(
            "omissions_reviewer_not_independent",
        );
        expect(omissionsFailures(input, sha, ["1:refusal code", "2:missing family"])).toContain(
            "omissions_family_inventory_mismatch",
        );
    });
});
