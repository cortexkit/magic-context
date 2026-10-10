/**
 * OpenCode 1's own conversion of session messages to provider messages, run
 * from a verbatim copy of its source for tests.
 *
 * `__fixtures__/opencode-v1.18.35-to-model-messages.txt` holds, byte for byte,
 * from OpenCode at tag v1.18.35 (commit 53d1eabb61e21162157817bf677da0a4ad3332e3):
 * `packages/opencode/src/util/media.ts` and `packages/opencode/src/util/iife.ts`
 * whole, then lines 46, 49-53 and 125-436 of
 * `packages/opencode/src/session/message-v2.ts`: `SYNTHETIC_ATTACHMENT_PROMPT`,
 * `truncateToolOutput`, `providerMeta`, `toModelMessagesEffect` and
 * `toModelMessages`. {@link OPENCODE1_EXCERPT_SHA256} pins that text; the
 * fidelity test fails if the copy changes, and, when an OpenCode checkout is
 * available, if the copy differs from upstream at the tag.
 *
 * The excerpt runs unchanged: its type annotations are stripped by Bun's
 * transpiler and its imports are supplied here. `convertToModelMessages` is the
 * AI SDK's (`ai` 6.0.168, the version OpenCode 1.18.35 pins) and `Effect` is
 * Effect 4; `MessageID.ascending` and `AbortedError.isInstance` stand in for
 * OpenCode's id generator and named-error check.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Loaded at run time rather than imported: Effect's type declarations augment
// the global Error type, which would change type checking across the package.
const requireFromHere = createRequire(import.meta.url);
const { convertToModelMessages } = requireFromHere("ai") as { convertToModelMessages: unknown };
const { Effect } = requireFromHere("effect") as { Effect: unknown };

/** An AI SDK model message, as the conversion returns it. */
export type ModelMessage = { role: string; content: unknown };

export const OPENCODE1_TAG = "v1.18.35";
export const OPENCODE1_COMMIT = "53d1eabb61e21162157817bf677da0a4ad3332e3";
/** Upstream files the excerpt is cut from, with their git blob ids at the tag. */
export const OPENCODE1_SOURCES = {
    media: {
        path: "packages/opencode/src/util/media.ts",
        blob: "566ac843a6342925e3e3d53f9b7dedf90c2d4a8e",
    },
    iife: {
        path: "packages/opencode/src/util/iife.ts",
        blob: "ca9ae6c10b44cfcfa5241048196675039ef8f8ec",
    },
    messages: {
        path: "packages/opencode/src/session/message-v2.ts",
        blob: "75f2d89379d79a847d684ad7def5b7215474dec7",
        lines: [
            [46, 46],
            [49, 53],
            [125, 436],
        ] as const,
    },
} as const;
export const OPENCODE1_EXCERPT_SHA256 =
    "e530c77ec018d8ed9628e1d416a1ef8fbfbadd72569f562264b4380d782b0ecb";
export const OPENCODE1_EXCERPT_URL = new URL(
    "./__fixtures__/opencode-v1.18.35-to-model-messages.txt",
    import.meta.url,
);

/** Assemble the excerpt from upstream file contents, the same way the fixture was cut. */
export function assembleOpencode1Excerpt(read: (path: string) => string): string {
    const lines = read(OPENCODE1_SOURCES.messages.path).split("\n");
    const pieces = OPENCODE1_SOURCES.messages.lines.map(([from, to]) =>
        lines.slice(from - 1, to).join("\n"),
    );
    return `${[
        read(OPENCODE1_SOURCES.media.path).replace(/\n+$/, ""),
        read(OPENCODE1_SOURCES.iife.path).replace(/\n+$/, ""),
        ...pieces,
    ].join("\n")}\n`;
}

export function readOpencode1Excerpt(): string {
    return readFileSync(OPENCODE1_EXCERPT_URL, "utf8");
}

export interface Opencode1Model {
    providerID: string;
    id: string;
    api: { npm: string; id: string };
}

type ToModelMessages = (
    input: unknown[],
    model: Opencode1Model,
    options?: { stripMedia?: boolean; toolOutputMaxChars?: number },
) => Promise<ModelMessage[]>;

let compiled: { toModelMessages: ToModelMessages; syntheticPrompt: string } | undefined;

function compile(): NonNullable<typeof compiled> {
    if (compiled) return compiled;
    // Module syntax is the only thing removed: the excerpt runs as a function
    // body whose free identifiers are the imports supplied below.
    const body = readOpencode1Excerpt().replace(/^export /gm, "");
    const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(body);
    let syntheticId = 0;
    const factory = new Function(
        "Effect",
        "convertToModelMessages",
        "MessageID",
        "AbortedError",
        `${javascript}\nreturn { toModelMessages, SYNTHETIC_ATTACHMENT_PROMPT };`,
    ) as (...deps: unknown[]) => {
        toModelMessages: ToModelMessages;
        SYNTHETIC_ATTACHMENT_PROMPT: string;
    };
    const module = factory(
        Effect,
        convertToModelMessages,
        { ascending: () => `msg_synthetic_${++syntheticId}` },
        // OpenCode's NamedError.isInstance compares the error's name.
        {
            isInstance: (error: unknown) =>
                typeof error === "object" &&
                error !== null &&
                (error as { name?: unknown }).name === "MessageAbortedError",
        },
    );
    compiled = {
        toModelMessages: module.toModelMessages,
        syntheticPrompt: module.SYNTHETIC_ATTACHMENT_PROMPT,
    };
    return compiled;
}

/** OpenCode 1.18.35's `MessageV2.toModelMessages`, run from the verbatim excerpt. */
export function opencode1ToModelMessages(
    input: unknown[],
    model: Opencode1Model,
    options?: { stripMedia?: boolean; toolOutputMaxChars?: number },
): Promise<ModelMessage[]> {
    return compile().toModelMessages(input, model, options);
}

export function opencode1SyntheticAttachmentPrompt(): string {
    return compile().syntheticPrompt;
}
