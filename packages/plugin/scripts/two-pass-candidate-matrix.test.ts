import { describe, expect, test } from "bun:test";
import { z } from "zod";
import matrix from "./two-pass-candidate-matrix.json";

const citation = z.object({
    path: z.string().startsWith(".cortexkit/"),
    line: z.number().int().positive(),
    quote: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const rowSchema = z.object({
    candidate: z.string().min(1),
    lane: z.enum(["opencode-1", "opencode-2", "omp"]),
    carriers: z.array(z.string().min(1)).min(1),
    provider: z.string().min(1).nullable(),
    providerSource: z.union([citation, z.literal("unknown")]),
    status: z.enum(["candidate", "dropped"]),
    modelId: z.string().min(1).nullable(),
    modelRoute: z.string().min(1).nullable(),
    variant: z.string().min(1).nullable(),
    variantSource: z.union([citation, z.literal("unknown")]),
    configuredTemperature: z.number().nullable(),
    configuredThinkingLevel: z.string().min(1).nullable(),
    configurationSource: z.union([citation, z.literal("unknown")]),
    priceClass: z.enum(["free", "paid"]).nullable(),
    tariffSource: z.union([citation, z.literal("unknown")]),
    pin_at: z.literal("V4 preflight"),
    modelEvidence: citation
        .extend({
            kind: z.enum(["recorded-request", "model-catalog", "configured-route"]),
        })
        .optional(),
    dropReason: z.string().min(1).optional(),
    dropReasonSource: z.union([citation, z.literal("unknown")]).optional(),
});

function validateRow(value: unknown) {
    const row = rowSchema.parse(value);
    if (row.status === "dropped") {
        if (!row.dropReason || row.modelId !== null || row.modelRoute !== null) {
            throw new Error("Dropped candidates must explain the missing id, not guess a route");
        }
        return row;
    }
    if (!row.modelEvidence) {
        throw new Error("A pinned candidate needs a model citation");
    }
    if (!row.provider || !row.modelId || row.modelRoute !== `${row.provider}/${row.modelId}`) {
        throw new Error("A pinned candidate needs an exact provider/model route");
    }
    // Evidence files are private and absent in ordinary checkouts; retain the literal id in the quote.
    const escapedId = row.modelId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`(?<![\\w.-])${escapedId}(?![\\w.-])`).test(row.modelEvidence.quote)) {
        throw new Error("The quoted evidence line does not contain the exact model id");
    }
    return row;
}

describe("two-pass candidate matrix", () => {
    test("has exactly one row per C1 candidate, with no Pi or ck-mc candidate", () => {
        const openCodeCandidates = [
            "DeepSeek V4.1 Flash",
            "GLM-5.3-Flash",
            "MiMo-V2.6-Flash",
            "Gemini 3.8 Flash",
            "Claude Sonnet 5.5",
        ];
        const expected = [
            ...["opencode-1", "opencode-2"].flatMap((lane) =>
                openCodeCandidates.map((candidate) => `${lane}:${candidate}`),
            ),
            "omp:Muse Spark 1.3",
        ];
        expect(matrix.version).toBe(1);
        expect(matrix.mode).toBe("best_effort");
        expect(matrix.rows.map((row) => `${row.lane}:${row.candidate}`).sort()).toEqual(
            expected.sort(),
        );
    });

    test("every row is either evidence-pinned or explicitly dropped", () => {
        for (const row of matrix.rows) validateRow(row);
    });

    test("lists both OpenCode 1 carriers until real-host preflight pins one", () => {
        for (const row of matrix.rows) {
            expect(row.carriers).toEqual(
                row.lane === "opencode-1"
                    ? ["hidden-completion", "opencode-session"]
                    : row.lane === "opencode-2"
                      ? ["hidden-completion"]
                      : ["pi-historian-rpc"],
            );
        }
    });

    function pinnedRow() {
        const row = matrix.rows.find((candidate) => candidate.status === "candidate");
        if (!row) throw new Error("The matrix must have an evidence-pinned control row");
        return structuredClone(row);
    }

    test("refuses an uncited candidate row", () => {
        const { modelEvidence: _evidence, ...uncited } = pinnedRow();
        expect(() => validateRow(uncited)).toThrow("needs a model citation");
    });

    test("refuses ids not present verbatim in the quoted evidence line", () => {
        const row = pinnedRow();
        row.modelId = "invented-model-id";
        row.modelRoute = `${row.provider}/${row.modelId}`;
        expect(() => validateRow(row)).toThrow("does not contain the exact model id");
        row.modelId = "flash";
        row.modelRoute = `${row.provider}/flash`;
        expect(() => validateRow(row)).toThrow("does not contain the exact model id");
    });

    test("keeps unresolved settings and tariffs explicitly unknown until V4 preflight", () => {
        for (const value of matrix.rows) {
            const row = validateRow(value);
            if (row.configurationSource === "unknown") {
                expect(row.configuredTemperature).toBeNull();
                expect(row.configuredThinkingLevel).toBeNull();
            }
            if (row.variantSource === "unknown") expect(row.variant).toBeNull();
            if (row.tariffSource === "unknown") expect(row.priceClass).toBeNull();
            expect(row.pin_at).toBe("V4 preflight");
        }
        const muse = matrix.rows.find((row) => row.lane === "omp");
        expect(muse?.provider).toBe("cline-pass");
        expect(muse?.status).toBe("dropped");
        expect(muse?.modelRoute).toBeNull();
    });

    test("refuses a model id without a file hash or a positive line number", () => {
        const row = pinnedRow();
        expect(() =>
            validateRow({ ...row, modelEvidence: { ...row.modelEvidence, sha256: "" } }),
        ).toThrow();
        expect(() =>
            validateRow({ ...row, modelEvidence: { ...row.modelEvidence, line: 0 } }),
        ).toThrow();
    });

    test("refuses a display-name citation as model-id evidence", () => {
        const row = pinnedRow();
        expect(() =>
            validateRow({ ...row, modelEvidence: { ...row.modelEvidence, kind: "display-name" } }),
        ).toThrow();
    });

    test("refuses a guessed id on a dropped candidate", () => {
        const row = pinnedRow();
        expect(() =>
            validateRow({ ...row, status: "dropped", dropReason: "Missing catalog" }),
        ).toThrow("not guess a route");
    });
});
