import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tool } from "@opencode-ai/plugin";
import { runMigrations } from "../features/magic-context/migrations";
import { initializeDatabase } from "../features/magic-context/storage-db";
import { Database } from "../shared/sqlite";
import { closeQuietly } from "../shared/sqlite-helpers";
import { createCtxNoteTools } from "./ctx-note/tools";
import { CTX_SEARCH_DESCRIPTION } from "./ctx-search/constants";
import { createCtxSearchTools } from "./ctx-search/tools";
import { CTX_SEARCH_LIGHT_DESCRIPTION } from "./light-descriptions";
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
    it("ctx_memory spells out required placeholder arguments in both presets", () => {
        expect(FULL_PARAMETER_DESCRIPTIONS.ctx_memory).toMatchObject({
            content:
                "The memory text — one standalone fact (write, update, merge). Archive and get take an empty string.",
            category:
                "Kind of fact: the new fact's kind for write; on update/merge, the memory's current category to keep it. Archive and get ignore it.",
            ids: "Memory ids from <project-memory>: one for update, one or more for archive, two or more for merge, 1–20 for get. Write takes an empty list.",
        });
        expect(LIGHT_PARAMETER_DESCRIPTIONS.ctx_memory).toMatchObject({
            content: "One standalone fact (write, update, merge). Archive and get: empty string.",
            category:
                "Kind of fact (write; on update/merge pass the current category to keep it). Archive and get ignore it.",
            ids: "Ids from <project-memory>: one for update, 1+ for archive, 2+ for merge, 1–20 for get. Write: empty list.",
        });
    });

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

    it("ctx_memory: required action-irrelevant arguments have explicit filler values", () => {
        expect(FULL_PARAMETER_DESCRIPTIONS.ctx_memory).toMatchObject({
            content:
                "The memory text — one standalone fact (write, update, merge). Archive and get take an empty string.",
            category:
                "Kind of fact: the new fact's kind for write; on update/merge, the memory's current category to keep it. Archive and get ignore it.",
            ids: "Memory ids from <project-memory>: one for update, one or more for archive, two or more for merge, 1–20 for get. Write takes an empty list.",
        });
        expect(LIGHT_PARAMETER_DESCRIPTIONS.ctx_memory).toMatchObject({
            content: "One standalone fact (write, update, merge). Archive and get: empty string.",
            category:
                "Kind of fact (write; on update/merge pass the current category to keep it). Archive and get ignore it.",
            ids: "Ids from <project-memory>: one for update, 1+ for archive, 2+ for merge, 1–20 for get. Write: empty list.",
        });
    });

    it("ctx_memory: the primary tool no longer describes the dreamer-only list limit", () => {
        for (const descriptions of Object.values(PRESETS)) {
            expect(Object.keys(descriptions.ctx_memory)).not.toContain("limit");
        }
    });
});
