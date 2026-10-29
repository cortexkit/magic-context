import { appendCompartments } from "../../src/features/magic-context/compartment-storage";
import { lifecycleTextHash } from "../../src/features/magic-context/memory/lifecycle-text";
import { insertMemory } from "../../src/features/magic-context/memory/storage-memory";
import {
    allocateTurnOneSend,
    commitTurnOnePublication,
    HISTORIAN_FORMAT_INSTRUCTION,
    parseEnabledTurnOne,
    publishedFacts,
} from "../../src/features/magic-context/memory/turn-one-publication";
import {
    selectTurnTwoFacts,
    TURN_TWO_PROMPT_MAX,
} from "../../src/features/magic-context/memory/turn-two";
import {
    applyDecidedPrefix,
    fitTurnTwoPrompt,
    parseTurnTwoEnvelope,
    type TurnTwoPromptFact,
} from "../../src/features/magic-context/memory/turn-two-envelope";
import { retrieveTurnTwoNeighbours } from "../../src/features/magic-context/memory/turn-two-retrieval";
import { initializeDatabase } from "../../src/features/magic-context/storage-db";
import {
    buildCompartmentAgentPrompt,
    historianSystemPrompt,
} from "../../src/hooks/magic-context/compartment-prompt";
import {
    shouldDiscardLastHistorianCompartment,
    validateHistorianOutput,
} from "../../src/hooks/magic-context/compartment-runner-validation";
import { Database } from "../../src/shared/sqlite";
import type { ReplayCase } from "../two-pass-live-replay/artifact-schema";
import type { Request } from "./provider";

function section(prompt: string, tag: string, required = false): string {
    const matches = [...prompt.matchAll(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, "g"))];
    if (matches.length > 1 || (required && matches.length !== 1))
        throw new Error(`recorded_section_${tag}`);
    return matches[0]?.[0] ?? "";
}
export function request(messages: Request["messages"]): Request {
    return {
        model: "deepseek-flash",
        messages,
        temperature: 0.1,
        max_tokens: 32000,
        thinking: { type: "disabled" },
        stream: false,
    };
}
export function turnOne(
    c: ReplayCase,
    thinking: Request["thinking"]["type"] = "disabled",
): Request {
    const transcript = section(c.userPrompt, "new_messages", true);
    // Remove only the builder's separators, not whitespace in the recorded transcript itself.
    const inputSource = transcript.slice(
        "<new_messages>\n\n".length,
        -"\n\n</new_messages>".length,
    );
    if (transcript !== `<new_messages>\n\n${inputSource}\n\n</new_messages>`)
        throw new Error("recorded_transcript_framing");
    const user = buildCompartmentAgentPrompt({
        seedExamples: section(c.userPrompt, "compartment_examples_from_other_projects"),
        sessionReferences: section(c.userPrompt, "session_references"),
        projectMemory: "",
        inputSource,
        memoryEnabled: true,
        anchoredFacts: true,
    });
    const first = request([
        { role: "system", content: historianSystemPrompt(true) },
        { role: "user", content: `${user}\n\n${HISTORIAN_FORMAT_INSTRUCTION}` },
    ]);
    first.thinking = { type: thinking };
    // Thinking can spend over 23k tokens reasoning on a large chunk, so a thinking
    // request gets room for its reasoning on top of the reply.
    if (thinking === "enabled") first.max_tokens = 64000;
    return first;
}

export interface MemoryDraft {
    factId: number;
    action: string;
    category: string;
    text: string;
    targetId?: number;
}
export interface SecondTurn {
    request: Request;
    facts: TurnTwoPromptFact[];
    deferredFacts: number;
    summary: string;
}

export async function turnTwo(
    c: ReplayCase,
    first: Request,
    reply: string,
    thinking: Request["thinking"]["type"] = "disabled",
): Promise<SecondTurn> {
    const xml = parseEnabledTurnOne(reply);
    if (xml === null) throw new Error("turn_one_envelope_invalid");
    const lastBlock = c.blocks.at(-1);
    if (!lastBlock) throw new Error("case_no_blocks");
    const chunk = {
        startIndex: c.blocks[0].startOrdinal,
        endIndex: lastBlock.endOrdinal,
        lines: c.lines,
    };
    const validated = validateHistorianOutput(xml, c.source.sessionId, chunk, [], 0);
    if (!validated.ok) throw new Error("turn_one_validation_failed");
    // Simulate normal publication: discard the last compartment when its boundary needs later context.
    const droppedTail = shouldDiscardLastHistorianCompartment(validated.compartments, chunk);
    const persisted = droppedTail ? validated.compartments.slice(0, -1) : validated.compartments;
    const db = new Database(":memory:");
    try {
        initializeDatabase(db);
        const project = "two-pass-small-trial";
        for (const memory of c.memories) {
            const stored = insertMemory(db, {
                projectPath: project,
                category: memory.category,
                content: memory.content,
                sourceType: "historian",
            });
            db.prepare("UPDATE memories SET id=?,revision=? WHERE id=?").run(
                memory.id,
                memory.revision,
                stored.id,
            );
        }
        const send = allocateTurnOneSend(db, {
            projectPath: project,
            sessionId: c.source.sessionId,
            harness: "direct-inference-trial",
            carrier: "in-process-chat-completions",
            lane: "enabled",
            chunkStart: chunk.startIndex,
            chunkEnd: chunk.endIndex,
        });
        appendCompartments(db, c.source.sessionId, persisted);
        const compartments = db
            .prepare(
                "SELECT id,start_message,end_message FROM compartments WHERE session_id=? ORDER BY sequence",
            )
            .all(c.source.sessionId) as Array<{
            id: number;
            start_message: number;
            end_message: number;
        }>;
        commitTurnOnePublication(db, {
            send,
            projectPath: project,
            sessionId: c.source.sessionId,
            honourAnchors: true,
            compartments: compartments.map((row, i) => ({
                id: row.id,
                startMessage: row.start_message,
                endMessage: row.end_message,
                replyStartMessage: persisted[i].startMessage,
                replyEndMessage: persisted[i].endMessage,
            })),
            blocks: c.blocks,
            candidateFacts: publishedFacts(
                validated.facts ?? [],
                persisted.length,
                droppedTail,
                null,
            ),
        });
        const facts: TurnTwoPromptFact[] = [];
        for (const fact of selectTurnTwoFacts(db, project, send.publicationId)) {
            const found = await retrieveTurnTwoNeighbours(db, project, fact.content, undefined);
            const blocks = db
                .prepare(`SELECT b.start_ordinal AS startOrdinal,b.end_ordinal AS endOrdinal,b.role,b.parts_json AS partsJSON
                FROM memory_fact_block_links l JOIN memory_fact_blocks b ON b.id=l.block_id WHERE l.fact_id=? ORDER BY b.start_ordinal`)
                .all(fact.id) as Array<{
                startOrdinal: number;
                endOrdinal: number;
                role: string;
                partsJSON: string;
            }>;
            facts.push({
                factId: fact.id,
                category: fact.category,
                content: fact.content,
                sourceSessionId: c.source.sessionId,
                anchorKnown: fact.anchor_known === 1,
                backlog: false,
                blocks: blocks.map((block) => ({
                    startOrdinal: block.startOrdinal,
                    endOrdinal: block.endOrdinal,
                    role: block.role,
                    parts: JSON.parse(block.partsJSON) as string[],
                })),
                neighbours: found.neighbours,
            });
        }
        if (facts.length === 0) throw new Error("turn_two_no_published_facts");
        const fitted = fitTurnTwoPrompt({
            facts,
            items: [],
            lexicalOnly: true,
            maxLength: TURN_TWO_PROMPT_MAX,
        });
        const selected = fitted.facts;
        const deferredFacts = fitted.deferred.facts;
        const second = fitted.prompt;
        const secondRequest = request([
            ...first.messages,
            { role: "assistant", content: reply },
            { role: "user", content: second },
        ]);
        secondRequest.thinking = { type: thinking };
        if (thinking === "enabled") secondRequest.max_tokens = 64000;
        return {
            request: secondRequest,
            facts: selected,
            deferredFacts,
            summary: xml,
        };
    } finally {
        db.close();
    }
}

export function memoryDrafts(
    reply: string,
    facts: TurnTwoPromptFact[],
    c: ReplayCase,
    diagnostics: { extraFactIds: number[] } = { extraFactIds: [] },
): MemoryDraft[] {
    const parsed = parseTurnTwoEnvelope(reply, false);
    if (!parsed.ok) throw new Error("turn_two_schema_invalid");
    const drafts: MemoryDraft[] = [];
    for (const [id, decision] of parsed.decisions) {
        const fact = facts.find((f) => f.factId === id);
        if (!fact) {
            diagnostics.extraFactIds.push(id);
            continue;
        }
        if (decision === "malformed") throw new Error("turn_two_schema_invalid");
        if (decision.action === "new")
            drafts.push({
                factId: id,
                action: decision.action,
                category: fact.category,
                text: applyDecidedPrefix(fact.content, decision.decided),
            });
        else if (["edit", "merge", "replaces"].includes(decision.action))
            drafts.push({
                factId: id,
                action: decision.action,
                category:
                    c.memories.find((m) => m.id === (decision.targetId ?? decision.survivorId))
                        ?.category ?? fact.category,
                text: decision.finalText ?? "",
                targetId: decision.targetId ?? decision.survivorId,
            });
    }
    if (facts.some((f) => !parsed.decisions.has(f.factId)))
        throw new Error("turn_two_missing_decision");
    return drafts;
}
export const requestHash = (value: Request) => lifecycleTextHash(JSON.stringify(value));

export function decisionChecks(reply: string): Array<{ factId: number; check: string }> {
    const parsed = parseTurnTwoEnvelope(reply, false);
    if (!parsed.ok) return [];
    return [...parsed.decisions.values()].flatMap((decision) =>
        decision === "malformed" ? [] : [{ factId: decision.factId, check: decision.check }],
    );
}
