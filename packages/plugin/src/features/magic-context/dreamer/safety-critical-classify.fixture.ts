import type { HiddenCompletionExecutor } from "../../../hooks/magic-context/compartment-runner-types";
import type { Database } from "../../../shared/sqlite";
import { getMemoryById } from "../memory";
import { type ClassifyArgs, runClassify } from "./classify";
import { acquireLease } from "./lease";

/** Run host selection with a deterministic provider reply. */
export async function classifySafetyFixture(db: Database, projectIdentity: string) {
    const prompted: number[] = [];
    const anchorIds: number[] = [];
    const manifestFor = (ids: number[]) => {
        prompted.push(...ids);
        return `<classify>${ids
            .map((id) => {
                const memory = getMemoryById(db, id);
                if (!memory) throw new Error(`fixture received an unknown memory ${id}`);
                const safety = memory.content.startsWith("Never push");
                return `<memory id="${id}" importance="1" scope="universe" shareable="true" safety_critical="${safety}"/>`;
            })
            .join("")}</classify>`;
    };
    let manifest = "";
    const executor: HiddenCompletionExecutor = {
        capabilities: { tools: false, harness: "opencode2" },
        open: async () => ({ id: "safety-classify" }),
        attempt: async (_handle, request) => {
            const parts = request.body?.parts as Array<{ text?: string }> | undefined;
            const prompt = parts?.[0]?.text ?? "";
            const [references, pool] = prompt.split("### Memory pool to classify");
            if (pool === undefined) throw new Error("classify prompt is missing its memory pool");
            anchorIds.push(
                ...[...references.matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1])),
            );
            manifest = manifestFor(
                [...pool.matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1])),
            );
        },
        collect: async () => ({
            text: manifest,
            reasoning: null,
            lengthCapped: false,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }),
        close: async () => {},
    };
    const holderId = "safety-fixture";
    const leaseKey = "safety-fixture-lease";
    if (!acquireLease(db, holderId, leaseKey)) throw new Error("fixture lease refused");
    const args: ClassifyArgs = {
        db,
        projectIdentity,
        holderId,
        leaseKey,
        parentSessionId: "safety-parent",
        sessionDirectory: process.cwd(),
        deadline: Date.now() + 60_000,
        hiddenCompletionExecutor: executor,
    };
    return { result: await runClassify(args), prompted, anchorIds };
}
