import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tool } from "@opencode-ai/plugin";
import { runMigrations } from "../features/magic-context/migrations";
import { initializeDatabase } from "../features/magic-context/storage-db";
import { Database } from "../shared/sqlite";
import { closeQuietly } from "../shared/sqlite-helpers";
import { CTX_MEMORY_DESCRIPTION } from "./ctx-memory/constants";
import { createCtxMemoryListTools } from "./ctx-memory/tools";
import { createCtxNoteTools } from "./ctx-note/tools";
import { CTX_SEARCH_DESCRIPTION } from "./ctx-search/constants";
import { createCtxSearchTools } from "./ctx-search/tools";
import { CTX_MEMORY_LIGHT_DESCRIPTION, CTX_SEARCH_LIGHT_DESCRIPTION } from "./light-descriptions";
import {
    FULL_PARAMETER_DESCRIPTIONS,
    LIGHT_PARAMETER_DESCRIPTIONS,
} from "./parameter-descriptions";

// Each block below pins a description that used to claim behavior the runtime
// does not have (issue 575): that `sources: []` searches nothing, that the
// default note read equals `filter: "active"`, that note reads take any number
// of ids, and that primary ctx_memory has a list `limit`; the search description
// also left out the `primer` source. Both presets are checked because full and light
// may differ in length but never in meaning.
const PRESETS = {
    full: FULL_PARAMETER_DESCRIPTIONS,
    light: LIGHT_PARAMETER_DESCRIPTIONS,
} as const;

describe("parameter descriptions match runtime behavior", () => {
    let db: Database;

    beforeEach(() => {
        db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
    });

    afterEach(() => {
        closeQuietly(db);
    });

    it("keeps the same parameter set in full and light", () => {
        for (const toolId of Object.keys(FULL_PARAMETER_DESCRIPTIONS)) {
            expect(
                Object.keys(
                    LIGHT_PARAMETER_DESCRIPTIONS[
                        toolId as keyof typeof LIGHT_PARAMETER_DESCRIPTIONS
                    ],
                ).sort(),
            ).toEqual(
                Object.keys(
                    FULL_PARAMETER_DESCRIPTIONS[toolId as keyof typeof FULL_PARAMETER_DESCRIPTIONS],
                ).sort(),
            );
        }
    });

    it("ctx_search sources: omitting it and passing [] both search every source", () => {
        // The runtime turns [] into "all sources" so providers that fill every
        // field with an empty value do not silently search nothing.
        for (const [preset, descriptions] of Object.entries(PRESETS)) {
            const text = descriptions.ctx_search.sources;
            expect({ preset, text }).toEqual({ preset, text: expect.stringContaining("[]") });
            expect(text).toMatch(/omit/);
            expect(text).not.toMatch(/none/);
        }
        const hostArgs = createCtxSearchTools({
            db,
            resolveProjectPath: () => "/repo/project",
            memoryEnabled: false,
            embeddingEnabled: false,
            readMessages: () => [],
        }).ctx_search.args;
        expect(hostArgs.sources?.description).toBe(FULL_PARAMETER_DESCRIPTIONS.ctx_search.sources);
    });

    it("ctx_search top-level descriptions name every source the schema accepts", () => {
        const hostArgs = createCtxSearchTools({
            db,
            resolveProjectPath: () => "/repo/project",
            memoryEnabled: false,
            embeddingEnabled: false,
            readMessages: () => [],
        }).ctx_search.args;
        const sourcesSchema = tool.schema.toJSONSchema(hostArgs.sources) as {
            items?: { enum?: string[] };
        };
        const sources = sourcesSchema.items?.enum ?? [];
        expect(sources).toContain("primer");
        for (const source of sources) {
            expect({ source, listed: CTX_SEARCH_DESCRIPTION.includes(`\n- ${source} — `) }).toEqual(
                {
                    source,
                    listed: true,
                },
            );
            expect({
                source,
                listed: CTX_SEARCH_LIGHT_DESCRIPTION.includes(` ${source} (`),
            }).toEqual({ source, listed: true });
        }
    });

    it("ctx_note filter: an omitted filter differs from explicit active", () => {
        // Omitted = active session notes plus every current smart note, pending
        // included; explicit `active` = stored status active only.
        for (const [preset, descriptions] of Object.entries(PRESETS)) {
            const text = descriptions.ctx_note.filter;
            expect({ preset, text }).toEqual({
                preset,
                text: expect.stringMatching(/Omitted[^;]*pending included/),
            });
            expect(text).toMatch(/active[^.;]*only|only[^.;]*active/);
            expect(text).not.toMatch(/active \(default/);
        }
    });

    it("ctx_note note_ids: reads are capped at 50 like dismiss", () => {
        for (const [preset, descriptions] of Object.entries(PRESETS)) {
            const text = descriptions.ctx_note.note_ids;
            expect({ preset, text }).toEqual({
                preset,
                text: expect.stringContaining("1–50 for dismiss, or 1–50 to read"),
            });
            expect(text).toContain("Write and a plain read take an empty list.");
            expect(text).not.toMatch(/\bany\b/);
        }
        const hostArgs = createCtxNoteTools({
            db,
            resolveProjectPath: () => "/repo/project",
        }).ctx_note.args;
        const noteIdsSchema = tool.schema.toJSONSchema(hostArgs.note_ids) as { maxItems?: number };
        expect(noteIdsSchema.maxItems).toBe(50);
        expect(hostArgs.filter?.description).toBe(FULL_PARAMETER_DESCRIPTIONS.ctx_note.filter);
        expect(hostArgs.note_ids?.description).toBe(FULL_PARAMETER_DESCRIPTIONS.ctx_note.note_ids);
    });

    it("ctx_memory: action-irrelevant arguments have explicit filler values", () => {
        expect(FULL_PARAMETER_DESCRIPTIONS.ctx_memory).toMatchObject({
            content:
                "Send on every call — the memory text for write, update and merge; pass an empty string for archive and get.",
            category:
                "Send on every call — the fact's kind for write; on update/merge, the memory's current category to keep it; archive and get ignore it, so pass any valid category.",
            ids: "Send on every call — one id for update, one or more for archive, two or more distinct ids of memories in the same category for merge, 1–20 for get; write takes an empty list.",
        });
        expect(LIGHT_PARAMETER_DESCRIPTIONS.ctx_memory).toMatchObject({
            content:
                "Send on every call: the fact (write, update, merge); empty string for archive/get.",
            category:
                "Send on every call: kind for write; current category for update/merge; any category for archive/get (ignored).",
            ids: "Send on every call: one id for update, 1+ for archive, 2+ distinct same-category ids for merge, 1–20 for get; write: empty list.",
        });
    });

    it("ctx_memory: fillers are described as the portable call form, not a schema requirement", () => {
        // On the Rust module neither ctx_memory schema has a `required` list,
        // so "required on every call" would be false there. Sending the fields
        // always works on every host, which is what the text must say.
        for (const descriptions of Object.values(PRESETS)) {
            for (const text of Object.values(descriptions.ctx_memory)) {
                expect(text).not.toContain("Required on every call");
            }
            expect(descriptions.ctx_memory.content).toContain("Send on every call");
        }
        // Enum-bearing schemas refuse category="", so the portable filler has to
        // be a valid category. The full text covered this; the light one must
        // say it as well.
        expect(FULL_PARAMETER_DESCRIPTIONS.ctx_memory.category).toContain("any valid category");
        expect(LIGHT_PARAMETER_DESCRIPTIONS.ctx_memory.category).toContain("any category");
        // The original regression was "category optional" in the update bullet;
        // guard that wording directly so it cannot come back.
        for (const descriptions of Object.values(PRESETS)) {
            expect(descriptions.ctx_memory.category).not.toContain("optional");
        }
        // "must not be found again" means keep the fact undiscoverable; the
        // light text must say the agent should not have to find it again.
        expect(CTX_MEMORY_LIGHT_DESCRIPTION).toContain("you must not have to find again");
        expect(CTX_MEMORY_LIGHT_DESCRIPTION).not.toContain("must not be found again");
        // merge refuses duplicate ids and cross-category sources, so "two or
        // more ids" alone is not the contract.
        for (const descriptions of Object.values(PRESETS)) {
            expect(descriptions.ctx_memory.ids).toContain("distinct");
            expect(descriptions.ctx_memory.ids).toMatch(/same.category/);
        }
        for (const description of [CTX_MEMORY_DESCRIPTION, CTX_MEMORY_LIGHT_DESCRIPTION]) {
            expect(description).toContain("distinct");
            expect(description).toMatch(/same.category/);
            expect(description).not.toContain("category optional");
            expect(description).not.toContain("category required");
        }
        expect(CTX_MEMORY_DESCRIPTION).toContain(
            "category: the current one to keep, a new one to recategorize",
        );
        expect(CTX_MEMORY_LIGHT_DESCRIPTION).toContain("update one id (content + category)");
        expect(CTX_MEMORY_DESCRIPTION).toContain("call form that works on every host");
    });

    it("ctx_memory_list category is an optional list filter, not a write action", () => {
        const listTools = createCtxMemoryListTools({
            db,
            resolveProjectPath: () => "/repo/project",
            memoryEnabled: true,
            embeddingEnabled: false,
        });
        expect(listTools.ctx_memory_list.args.category?.description).toBe(
            "Filter listed memories to this category (optional).",
        );
    });

    it("ctx_memory: the primary tool no longer describes the dreamer-only list limit", () => {
        for (const descriptions of Object.values(PRESETS)) {
            expect(Object.keys(descriptions.ctx_memory)).not.toContain("limit");
        }
    });
});
