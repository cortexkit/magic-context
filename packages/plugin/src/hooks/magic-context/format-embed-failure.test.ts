import { describe, expect, test } from "bun:test";
import type { EmbeddingFailure } from "../../features/magic-context/memory/embedding-failure";
import { formatEmbedFailureSummary } from "./format-embed-failure";

const failures: EmbeddingFailure[] = [
    {
        class: "substitution_rejected",
        reason: "served model 'bge-m3' does not match requested 'baai/bge-m3-embedding' (substitution guard)",
        retryable: false,
    },
    {
        class: "http_error",
        reason: "HTTP 402 from endpoint: quota exhausted",
        retryable: false,
    },
    {
        class: "empty_result",
        reason: "response data[] was empty",
        retryable: true,
    },
    {
        class: "invalid_envelope",
        reason: "response had keys [object, results] but data[] was absent",
        retryable: false,
    },
];

describe("formatEmbedFailureSummary", () => {
    test.each(failures)("surfaces $class without a misleading retry instruction", (failure) => {
        const summary = formatEmbedFailureSummary(0, 193, failure);
        expect(summary).toContain(failure.reason);
        if (failure.retryable) {
            expect(summary).toContain("Run /ctx-embed start again to retry them.");
        } else {
            expect(summary).not.toContain("Run /ctx-embed start again to retry them.");
        }
    });
});
