/**
 * Replay recorded production two-pass conversations with a different turn-two
 * prompt, and report how the replies parse.
 *
 * Each case is one production publication: the historian system prompt, the
 * turn-one user message and reply as they were sent and received, and the
 * turn-two prompt's body (everything after its fixed instructions). The replay
 * keeps all of that byte for byte and swaps only the fixed instructions, so a
 * difference in the replies comes from the instructions alone.
 *
 *   # Parse the recorded production replies (no provider call):
 *   bun replay-turn-two.ts --cases <cases.json> --out <dir> --mode recorded
 *   # Send to DeepSeek Flash with the current or the earlier instructions:
 *   bun replay-turn-two.ts --cases <cases.json> --out <dir> --mode deepseek \
 *     --prompt current|<earlier turn-two.md> --enrollment <mc-e2e enrollment.json>
 *   # Add `--system <file>` to any sending mode to replace the recorded system
 *   # prompt, for example with the one-pass prompt OpenCode 1's registered
 *   # historian agent sends.
 *   # Write Anthropic Messages bodies for someone else to send:
 *   bun replay-turn-two.ts --cases <cases.json> --out <dir> --mode anthropic-bodies
 *   # Parse replies another seat returned (<dir>/<n>.reply.txt):
 *   bun replay-turn-two.ts --cases <cases.json> --out <dir> --mode replies
 *
 * Cases come from the live store and hold private conversation text, so they and
 * every output stay outside the repository, owner-only.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseTurnTwoEnvelope } from "../../src/features/magic-context/memory/turn-two-envelope";
import { TWO_PASS_TURN_TWO } from "../../src/hooks/magic-context/two-pass-prompts/prompts.generated";
import { fetchForRun, macCredentialSource } from "../two-pass-activation-runs/container-launcher";
import { DeepSeek, Ledger, logger, type Request } from "./provider";
import type { Config } from "./run";

interface Case {
    publicationId: string;
    sessionId: string;
    system: string;
    turnOneUser: string;
    turnOneReply: string;
    allowedIds: number[];
    turnTwoRest: string;
    productionTurnTwoReply: string;
}

type Verdict = "valid" | "malformed" | "missing";

interface Outcome {
    index: number;
    envelope: string;
    perFact: Record<string, Verdict>;
    actions: Record<string, number>;
    extraIds: number[];
}

/** How a reply parses for one case, with the production parser. */
export function judge(
    index: number,
    allowed: number[],
    text: string,
    lengthCapped = false,
): Outcome {
    const parsed = parseTurnTwoEnvelope(text, lengthCapped);
    const outcome: Outcome = { index, envelope: "ok", perFact: {}, actions: {}, extraIds: [] };
    if (!parsed.ok) {
        outcome.envelope = parsed.reason;
        for (const id of allowed) outcome.perFact[id] = "missing";
        return outcome;
    }
    for (const id of allowed) {
        const decision = parsed.decisions.get(id);
        if (decision === undefined) outcome.perFact[id] = "missing";
        else if (decision === "malformed") outcome.perFact[id] = "malformed";
        else {
            outcome.perFact[id] = "valid";
            outcome.actions[decision.action] = (outcome.actions[decision.action] ?? 0) + 1;
        }
    }
    outcome.extraIds = [...parsed.decisions.keys()].filter((id) => !allowed.includes(id));
    return outcome;
}

function turnTwoPrompt(c: Case, instructions: string) {
    return (
        instructions.replace("{{ALLOWED_FACT_IDS}}", () => JSON.stringify(c.allowedIds)) +
        c.turnTwoRest
    );
}

function summary(outcomes: Outcome[]) {
    const totals = { valid: 0, malformed: 0, missing: 0 };
    const actions: Record<string, number> = {};
    const lines = outcomes.map((o) => {
        const counts = { valid: 0, malformed: 0, missing: 0 };
        for (const verdict of Object.values(o.perFact)) counts[verdict]++;
        for (const key of Object.keys(totals) as Verdict[]) totals[key] += counts[key];
        for (const [action, n] of Object.entries(o.actions))
            actions[action] = (actions[action] ?? 0) + n;
        return `case ${o.index}: envelope=${o.envelope} valid=${counts.valid} malformed=${counts.malformed} missing=${counts.missing} extra=${o.extraIds.length}`;
    });
    lines.push(
        `total: valid=${totals.valid} malformed=${totals.malformed} missing=${totals.missing} actions=${JSON.stringify(actions)}`,
    );
    return lines.join("\n");
}

function save(path: string, text: string) {
    writeFileSync(path, text, { mode: 0o600 });
}

async function main() {
    const args = process.argv.slice(2);
    const option = (name: string) => {
        const at = args.indexOf(name);
        const value = args[at + 1];
        if (at < 0 || !value) throw new Error(`missing ${name}`);
        return value;
    };
    const mode = option("--mode");
    const all: Case[] = JSON.parse(readFileSync(option("--cases"), "utf8"));
    const select = args.includes("--select")
        ? option("--select").split(",").map(Number)
        : all.map((_, index) => index);
    const out = resolve(option("--out"));
    const pick = (index: number): Case => {
        const c = all[index];
        if (!c) throw new Error(`no case ${index}`);
        return c;
    };
    const instructions =
        !args.includes("--prompt") || option("--prompt") === "current"
            ? TWO_PASS_TURN_TWO
            : readFileSync(option("--prompt"), "utf8");
    if (args.includes("--system")) {
        const system = readFileSync(option("--system"), "utf8");
        for (const c of all) c.system = system;
    }

    if (mode === "replies") {
        const outcomes = select.map((index) => {
            const text = readFileSync(resolve(out, `${index}.reply.txt`), "utf8");
            return judge(index, pick(index).allowedIds, text);
        });
        const report = summary(outcomes);
        save(resolve(out, "report.txt"), `${report}\n`);
        save(resolve(out, "outcomes.json"), JSON.stringify(outcomes, null, 1));
        console.log(report);
        return;
    }
    if (existsSync(out)) throw new Error("output directory exists; choose a fresh one");
    mkdirSync(out, { recursive: true, mode: 0o700 });

    if (mode === "recorded") {
        const outcomes = select.map((index) =>
            judge(index, pick(index).allowedIds, pick(index).productionTurnTwoReply),
        );
        const report = summary(outcomes);
        save(resolve(out, "report.txt"), `${report}\n`);
        console.log(report);
        return;
    }
    if (mode === "anthropic-bodies") {
        for (const index of select) {
            const c = pick(index);
            const body = {
                model: "claude-sonnet-5-5",
                max_tokens: 32000,
                temperature: 0.1,
                system: c.system,
                messages: [
                    { role: "user", content: c.turnOneUser },
                    { role: "assistant", content: c.turnOneReply },
                    { role: "user", content: turnTwoPrompt(c, instructions) },
                ],
            };
            save(resolve(out, `${index}.body.json`), JSON.stringify(body));
        }
        console.log(`wrote ${select.length} bodies to ${out}`);
        return;
    }
    if (mode !== "deepseek") throw new Error(`unknown mode ${mode}`);
    if (process.platform !== "darwin") throw new Error("credential_broker_trusted_host_required");
    const config = JSON.parse(
        readFileSync(resolve(import.meta.dir, "deepseek.json"), "utf8"),
    ) as Pick<Config, "endpoint" | "grant" | "peakUSDPerMillion">;
    const ledgerPath = resolve(out, "ledger.json");
    const ledger: Ledger = new Ledger(2, config.peakUSDPerMillion, () =>
        save(ledgerPath, JSON.stringify(ledger.rows, null, 1)),
    );
    const source = await macCredentialSource(option("--enrollment"));
    let material = "";
    try {
        material = await fetchForRun(source, config.grant, 3_600_000);
        const log = logger(material, (text) => process.stdout.write(text));
        const client = new DeepSeek({
            endpoint: config.endpoint,
            material,
            ledger,
            save: () => save(ledgerPath, JSON.stringify(ledger.rows, null, 1)),
            log,
        });
        const outcomes: Outcome[] = [];
        for (const index of select) {
            const c = pick(index);
            const request: Request = {
                model: "deepseek-flash",
                messages: [
                    { role: "system", content: c.system },
                    { role: "user", content: c.turnOneUser },
                    { role: "assistant", content: c.turnOneReply },
                    { role: "user", content: turnTwoPrompt(c, instructions) },
                ],
                temperature: 0.1,
                max_tokens: 32000,
                thinking: { type: "disabled" },
                stream: false,
            };
            let text: string;
            try {
                text = await client.send(request, index, 2);
            } catch (error) {
                const reason = error instanceof Error ? error.message : "error";
                save(resolve(out, `${index}.reply.txt`), `[no reply: ${reason}]`);
                outcomes.push({ ...judge(index, c.allowedIds, ""), envelope: reason });
                if (reason !== "incomplete_response") break;
                continue;
            }
            save(resolve(out, `${index}.reply.txt`), text);
            outcomes.push(judge(index, c.allowedIds, text));
            log(`case ${index} replied`);
        }
        const report = summary(outcomes);
        save(resolve(out, "report.txt"), `${report}\nspentUSD=${ledger.committedUSD.toFixed(4)}\n`);
        save(resolve(out, "outcomes.json"), JSON.stringify(outcomes, null, 1));
        log(report);
        log(`spentUSD=${ledger.committedUSD.toFixed(4)}`);
    } finally {
        material = "";
        await source.close();
    }
}

if (import.meta.main)
    main().catch((error) => {
        // Vault and provider errors can carry secrets: print only the error's code.
        const code =
            error instanceof Error && /^[a-z_ ]+/.test(error.message)
                ? error.message.split(":")[0]
                : "error";
        process.stderr.write(`replay failed: ${code}\n`);
        process.exitCode = 1;
    });
