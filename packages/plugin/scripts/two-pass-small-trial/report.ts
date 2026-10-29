import type { Claim, ReplayCase } from "../two-pass-live-replay/artifact-schema";
import type { MemoryDraft } from "./prompts";
import type { Attempt, Request } from "./provider";

export interface CaseResult {
    caseId: number;
    firstRequest: Request;
    firstReply?: string;
    summary?: string;
    secondRequest?: Request;
    secondReply?: string;
    checks?: Array<{ factId: number; check: string }>;
    drafts?: MemoryDraft[];
    deferredFacts?: number;
    extraFactIds?: number[];
    failure?: string;
}
export interface RunResult {
    mode: "mock" | "live";
    started: string;
    ended?: string;
    failure?: string;
    cases: CaseResult[];
    attempts: Attempt[];
}
const cell = (s: string) =>
    s
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("|", "&#124;")
        .replaceAll("\n", "<br>");
const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []);
const sentences = (s: string) =>
    s.split(/\n+|(?<=[.!?])\s+/).filter((line) => words(line).size >= 4);
function similarity(a: string, b: string) {
    const x = words(a),
        y = words(b);
    return [...x].filter((w) => y.has(w)).length / Math.max(x.size, 1);
}
function nearest(text: string, candidates: string[]) {
    return (
        candidates
            .map((candidate) => ({ text: candidate, score: similarity(text, candidate) }))
            .sort((a, b) => b.score - a.score)[0] ?? { text: "", score: 0 }
    );
}
export function mechanicalClaim(claim: Claim, drafts: MemoryDraft[]) {
    const evidence = nearest(
        claim.text,
        drafts.flatMap((m) => sentences(m.text)),
    );
    const negative = (s: string) =>
        /\b(no|not|never|forbidden|mustn't|cannot|can't|without)\b/i.test(s);
    const numbers = (s: string) => [...s.matchAll(/\b\d+(?:\.\d+)?\b/g)].map((m) => m[0]);
    const conflictingNumbers =
        numbers(claim.text).length > 0 &&
        numbers(evidence.text).length > 0 &&
        !numbers(claim.text).every((n) => numbers(evidence.text).includes(n));
    const mark =
        evidence.score >= 0.5 &&
        (negative(claim.text) !== negative(evidence.text) || conflictingNumbers)
            ? "CONTRADICTED? (negation/number mismatch)"
            : evidence.score >= 0.65
              ? "CAPTURED?"
              : "MISSED? (no strong lexical match)";
    return { mark, evidence };
}
export const DOCS = `Public DeepSeek docs fetched 2026-10-26 (UTC):
- [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/): model \`deepseek-flash\`, version DeepSeek-V4.1-Flash-1017; OpenAI base URL \`https://api.deepseek.com\`.
- USD per million tokens: cache-hit input $0.003 off-peak / $0.006 peak; cache-miss input $0.15 / $0.30; output $0.60 / $1.20. Per-token values are those amounts divided by 1,000,000.
- USD per token (off-peak / peak): cache-hit input $0.000000003 / $0.000000006; cache-miss input $0.00000015 / $0.00000030; output $0.00000060 / $0.00000120.
- Peak: 01:00–04:00 and 06:00–10:00 UTC Monday–Friday, excluding Chinese public holidays. Otherwise off-peak. This runner reports a conservative **peak-price cost ceiling**, not an invoice; it never assumes off-peak discounts or cache hits when reserving.
- [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion): POST /chat/completions; usage.prompt_cache_hit_tokens and usage.prompt_cache_miss_tokens sum to usage.prompt_tokens; usage.completion_tokens counts output. Raw usage is retained.
- [Context Caching](https://api-docs.deepseek.com/guides/kv_cache/): caching is enabled by default but best effort; identical conversation prefixes do not guarantee a cache hit.
`;

export function report(result: RunResult, cases: ReplayCase[]): string {
    const rows = result.attempts;
    const charged = rows.reduce((sum, r) => sum + (r.costCeilingUSD ?? 0), 0);
    const committed = rows.reduce((sum, r) => sum + (r.costCeilingUSD ?? r.reservedUSD), 0);
    const t2 = rows.flatMap((r) => (r.turn === 2 && r.usage ? [r.usage] : []));
    const hit = t2.reduce((sum, usage) => sum + usage.prompt_cache_hit_tokens, 0);
    const prompt = t2.reduce((sum, usage) => sum + usage.prompt_tokens, 0);
    const lines = [
        "# Two-pass small trial review",
        "",
        `Mode: **${result.mode}**. Started ${result.started}; ended ${result.ended ?? "in progress"}.`,
        "",
        "## Read this first",
        "",
        "Mechanical first pass for human correction, **not a semantic grade or production activation**. CAPTURED?/MISSED?/CONTRADICTED? use word overlap and negation/numeric hints, not entailment. Read every claim and full output. An unsupported-output flag is a review lead, not proof of invention; absence of a flag is not proof of support.",
        "",
        "Memory text below is what turn two **proposed** to write (new facts or final edit/merge/replacement text). No production store is opened or modified; narrow safety checks, publication authorization and the applier are deliberately not run. Covered/conflict/abstain are not new writes; all decisions remain in the raw turn-two response. Existing-memory coverage is not counted as a captured new write.",
        "",
        "Requests use production prompt builders, frozen recorded seed/reference/transcript blocks, an empty project-memory block on turn one, and production lexical-neighbour retrieval on an in-memory seeded store on turn two. Turn-one validation/publication uses ordinary non-emergency tail discard, no forced weak-final publication, and no recovered tool-arc metadata. No semantic embeddings, earlier-publication backlog or due agent-memory scores exist in this isolated replay. Turn two keeps the exact system/user/assistant prefix. No extra model grader, stripped arm, repair or third check call is made. Verbatim responses exclude only redacted credential material if a provider echoes it.",
        "",
        "## Totals",
        "",
        `Observed-usage cost range: off-peak lower bound $${(charged / 2).toFixed(8)}; peak ceiling $${charged.toFixed(8)} (not an exact invoice). Ledger committed (including unknown/refused attempts at full reservation): $${committed.toFixed(8)} / $2. Unknown-usage attempts have cost range $0–reservation, not a claimed zero charge.`,
        `Turn-two cache-hit share: ${prompt ? `${((100 * hit) / prompt).toFixed(2)}% (${hit}/${prompt} input tokens)` : "unavailable (no valid turn-two usage)"}.`,
        `Failures: ${result.cases.filter((c) => c.failure).length} case(s); terminal=${result.failure ?? "none"}; HTTP attempts=${rows.length}; retry-429=${rows.filter((r) => r.error === "retry_429").length}.`,
        "",
        "| Case | Turn | Attempt | HTTP | Hit / miss / output tokens | Latency ms | Off-peak lower USD | Peak ceiling USD | Error |",
        "|---|---|---|---|---|---|---|---|---|",
    ];
    for (const r of rows)
        lines.push(
            `| ${r.caseId} | ${r.turn} | ${r.attempt + 1} | ${r.status ?? "unknown"} | ${r.usage ? `${r.usage.prompt_cache_hit_tokens} / ${r.usage.prompt_cache_miss_tokens} / ${r.usage.completion_tokens}` : "unknown; reservation retained"} | ${r.latencyMs?.toFixed(1) ?? "?"} | ${r.costCeilingUSD === undefined ? "unknown (0 minimum)" : (r.costCeilingUSD / 2).toFixed(8)} | ${r.costCeilingUSD?.toFixed(8) ?? `reserved ${r.reservedUSD.toFixed(8)}`} | ${r.error ?? ""} |`,
        );
    lines.push("", "## Provider provenance", "", DOCS);
    for (const c of cases) {
        const item = result.cases.find((r) => r.caseId === c.id);
        lines.push(
            "",
            `## Case ${c.id}`,
            "",
            `${Buffer.byteLength(c.userPrompt)} recorded input bytes; ${c.inventory.value.length} reviewed claims; source ${c.source.recording} (${c.source.sha256}).`,
            "",
            `Status: ${item?.failure ?? (item?.secondReply ? "both turns returned" : "not run")}; facts deferred by prompt fit: ${item?.deferredFacts ?? "unknown"}.`,
            `Ignored extra fact ids: ${item?.extraFactIds?.join(", ") || "none"}.`,
            "",
            "### Turn-one summary (verbatim XML when available; raw reply otherwise)",
            "",
            `<pre>${cell(item?.summary ?? item?.firstReply ?? "Not available")}</pre>`,
            "",
            "### Proposed memory writes beside reviewed claims",
            "",
            "| Turn-two category and text | Reviewed corpus claim | Mechanical mark and nearest evidence |",
            "|---|---|---|",
        );
        const drafts = item?.drafts ?? [];
        for (let i = 0; i < Math.max(c.inventory.value.length, drafts.length); i++) {
            const draft = drafts[i],
                claim = c.inventory.value[i];
            const assessment = claim && item?.drafts ? mechanicalClaim(claim, drafts) : undefined;
            lines.push(
                `| ${draft ? cell(`Fact ${draft.factId} ${draft.action} [${draft.category}]${draft.targetId ? ` target #${draft.targetId}` : ""}\n${draft.text}`) : ""} | ${claim ? cell(`${claim.id} [${claim.family}] (${claim.anchor.startOrdinal}-${claim.anchor.endOrdinal})\n${claim.text}`) : ""} | ${assessment ? cell(`${assessment.mark} overlap=${assessment.evidence.score.toFixed(2)}\n${assessment.evidence.text}`) : claim ? "NOT ASSESSED (no schema-valid completed turn two)" : ""} |`,
            );
        }
        const source = c.blocks.flatMap((b) => b.parts).join("\n");
        const supports = [
            ...sentences(source),
            ...c.inventory.value.map((claim) => claim.text),
            ...c.memories.flatMap((m) => sentences(m.content)),
        ];
        const unsupported = drafts
            .flatMap((m) => sentences(m.text))
            .filter((s) => nearest(s, supports).score < 0.45);
        lines.push(
            "",
            "### Possible unsupported inventions (mechanical flags)",
            "",
            ...(unsupported.length
                ? unsupported.map((s) => `- ${cell(s)}`)
                : ["None flagged by word overlap; human source review still required."]),
            "",
            "### Turn-two response (verbatim)",
            "",
            `<pre>${cell(item?.secondReply ?? "Not available")}</pre>`,
        );
    }
    return `${lines.join("\n")}\n`;
}
