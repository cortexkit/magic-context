import "./quiet-live-log";
/**
 * Generate the differential historian USER-prompt golden for the Rust mc-module port.
 *
 * Run:        bun crates/mc-module/gen/gen-historian-prompt-golden.ts
 * Drift check: bun crates/mc-module/gen/gen-historian-prompt-golden.ts --check
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pluginDir = join(import.meta.dir, "..", "..", "..", "packages", "plugin");
const resolve = (m: string) => Bun.resolveSync(m, pluginDir);

const promptMod = await import(resolve("./src/hooks/magic-context/compartment-prompt"));
const referenceMod = await import(resolve("./src/hooks/magic-context/reference-retrieval"));
const injectMod = await import(resolve("./src/hooks/magic-context/inject-compartments"));
const seedsMod = await import(resolve("./src/hooks/magic-context/reference-seeds.generated"));

const { buildCompartmentAgentPrompt } = promptMod as {
    buildCompartmentAgentPrompt: (inputs: {
        seedExamples: string;
        sessionReferences: string;
        projectMemory: string;
        inputSource: string;
        memoryEnabled?: boolean;
        userObservationsRequested?: boolean;
        extractionFree?: boolean;
    }) => string;
};
const { buildReferenceBlocks, selectSeeds, renderSeedExamplesBlock, selectSessionReferences, renderSessionReferencesBlock } = referenceMod as {
    buildReferenceBlocks: (args: {
        sessionId: string;
        chunkStart: number;
        sessionCompartments: TsReferenceCompartment[];
    }) => { seedExamples: string; sessionReferences: string };
    selectSeeds: (
        sessionId: string,
        chunkStart: number,
        count?: number,
    ) => Array<{ importance: number; block: string }>;
    renderSeedExamplesBlock: (seeds: Array<{ importance: number; block: string }>) => string;
    selectSessionReferences: (compartments: TsReferenceCompartment[], seeds: Array<{ importance: number; block: string }>, sessionId: string, chunkStart: number) => TsReferenceCompartment[];
    renderSessionReferencesBlock: (selected: TsReferenceCompartment[], window?: number) => string;
};
const { renderHistorianMemoryBlock } = injectMod as {
    renderHistorianMemoryBlock: (memories: TsMemory[]) => string | null;
};
const { REFERENCE_SEEDS } = seedsMod as {
    REFERENCE_SEEDS: ReadonlyArray<{ importance: number; block: string }>;
};

interface ReferenceCompartmentJson {
    start_message: number;
    end_message: number;
    title: string;
    content: string;
    p1?: string | null;
    p2?: string | null;
    p3?: string | null;
    p4?: string | null;
    importance?: number | null;
    episode_type?: string | null;
}

interface TsReferenceCompartment {
    startMessage: number;
    endMessage: number;
    title: string;
    content: string;
    p1?: string | null;
    p2?: string | null;
    p3?: string | null;
    p4?: string | null;
    importance?: number | null;
    episodeType?: string | null;
}

interface MemoryJson {
    id: number;
    category: string;
    content: string;
}

interface TsMemory extends MemoryJson {
    projectPath: string;
    normalizedHash: string;
    importance: number;
    scope: string;
    shareable: number;
    sourceSessionId: string | null;
    sourceType: string;
    seenCount: number;
    retrievalCount: number;
    firstSeenAt: number;
    createdAt: number;
    updatedAt: number;
    lastSeenAt: number;
    lastRetrievedAt: number | null;
    status: string;
    expiresAt: number | null;
    verificationStatus: string;
    verifiedAt: number | null;
    supersededByMemoryId: number | null;
    mergedFrom: string | null;
    metadataJson: string | null;
}

interface SeedCaseSpec {
    label: string;
    session_id: string;
    chunk_start: number;
    count: number;
}

interface SeedCase extends SeedCaseSpec {
    selected_indices: number[];
    seed_examples: string;
}

interface PromptCaseSpec {
    label: string;
    session_id: string;
    chunk_start: number;
    session_compartments: ReferenceCompartmentJson[];
    memories: MemoryJson[];
    input_source: string;
    memory_enabled: boolean;
    /** Set only by the dreamer-disabled cases; absent means true, so the
     *  earlier cases keep their exact JSON. */
    user_observations_requested?: boolean;
    extraction_free: boolean;
}

interface PromptCase extends PromptCaseSpec {
    selected_seed_indices: number[];
    seed_examples: string;
    session_references: string;
    project_memory: string;
    prompt: string;
}

function toTsCompartment(c: ReferenceCompartmentJson): TsReferenceCompartment {
    return {
        startMessage: c.start_message,
        endMessage: c.end_message,
        title: c.title,
        content: c.content,
        p1: c.p1 ?? null,
        p2: c.p2 ?? null,
        p3: c.p3 ?? null,
        p4: c.p4 ?? null,
        importance: c.importance ?? null,
        episodeType: c.episode_type ?? null,
    };
}

function toTsMemory(m: MemoryJson): TsMemory {
    return {
        id: m.id,
        projectPath: "/repo/project",
        category: m.category,
        content: m.content,
        normalizedHash: `hash-${m.id}`,
        importance: 50,
        scope: "project",
        shareable: 0,
        sourceSessionId: "source-session",
        sourceType: "historian",
        seenCount: 1,
        retrievalCount: 0,
        firstSeenAt: 1,
        createdAt: 1,
        updatedAt: 1,
        lastSeenAt: 1,
        lastRetrievedAt: null,
        status: "active",
        expiresAt: null,
        verificationStatus: "unverified",
        verifiedAt: null,
        supersededByMemoryId: null,
        mergedFrom: null,
        metadataJson: null,
    };
}

function selectedSeedIndices(sessionId: string, chunkStart: number, count: number): number[] {
    return selectSeeds(sessionId, chunkStart, count).map((seed) => {
        const idx = REFERENCE_SEEDS.indexOf(seed);
        if (idx < 0) {
            throw new Error(`selected seed was not from REFERENCE_SEEDS for ${sessionId}:${chunkStart}`);
        }
        return idx;
    });
}

const matureCompartments: ReferenceCompartmentJson[] = [
    {
        start_message: 1,
        end_message: 5,
        title: "older low-mid one",
        content: "old content one",
        importance: 10,
    },
    {
        start_message: 6,
        end_message: 12,
        title: "older low-mid two",
        content: "old content two",
        importance: 20,
    },
    {
        start_message: 13,
        end_message: 20,
        title: "Escaped title & \"quotes\" 'apostrophe' <tag>",
        content: "unused v2 content",
        p1: "P1 says A & B < C > D",
        p2: "P2 uses \"quotes\" & ampersand",
        p3: "P3 keeps 'apostrophe' <tag>",
        p4: "",
        importance: null,
        episode_type: "design&bug\"triage'",
    },
    {
        start_message: 21,
        end_message: 27,
        title: "Legacy <flat> & row",
        content: "Legacy content & <xml> > \"quote\" 'apostrophe'",
        p1: null,
        p2: null,
        p3: null,
        p4: null,
        importance: 77,
        episode_type: null,
    },
    {
        start_message: 28,
        end_message: 31,
        title: "Pseudo v2 empty p1 falls back",
        content: "Fallback content because p1 is empty & visible",
        p1: "",
        p2: "ignored p2",
        p3: "ignored p3",
        p4: "ignored p4",
        importance: 66,
        episode_type: "investigation",
    },
    {
        start_message: 32,
        end_message: 40,
        title: "Tiered p4 body",
        content: "unused content",
        p1: "Full tier body",
        p2: "Short tier body",
        p3: "Outcome tier body",
        p4: "Anchor & <p4>",
        importance: 5,
        episode_type: "release",
    },
    {
        start_message: 41,
        end_message: 45,
        title: "Legacy empty episode type",
        content: "Episode type is empty string, so the attribute is omitted.",
        p1: null,
        importance: 50,
        episode_type: "",
    },
    {
        start_message: 46,
        end_message: 52,
        title: "Tiered null lower tiers",
        content: "unused",
        p1: "Only P1 is populated",
        p2: null,
        p3: null,
        p4: null,
        importance: 88,
        episode_type: "feature",
    },
];

const promptCaseSpecs: PromptCaseSpec[] = [
    {
        label: "young session seed floor only",
        session_id: "young-session",
        chunk_start: 0,
        session_compartments: [],
        memories: [],
        input_source: "Messages 1-3:\n\n[1] U: Start <feature> & check \"quotes\"\n[2] A: Done\n[3] U: thanks",
        memory_enabled: true,
        extraction_free: false,
    },
    {
        label: "mature session refs and category memory",
        session_id: "mature-<&\"'-🚀",
        chunk_start: 42,
        session_compartments: matureCompartments,
        memories: [
            { id: 1, category: "NAMING", content: "Use Foo & Bar <Baz> in examples" },
            { id: 2, category: "PROJECT_RULES", content: "Never rewrite generated files > their source" },
            { id: 3, category: "ARCHITECTURE", content: "Core path is crates/mc-module" },
            { id: 4, category: "CONSTRAINTS", content: "Escape \"quotes\" but content leaves them literal" },
            { id: 5, category: "CONFIG_VALUES", content: "timeout_ms=5000 & mode=fast" },
            { id: 6, category: "USER_DIRECTIVES", content: "Legacy user directive survives" },
            { id: 7, category: "UNKNOWN", content: "unknown category is not rendered" },
        ],
        input_source: "Messages 53-56:\n\n[53] U: continue with XML chars & < >\n[54] A: implementing\n[55] TC: read(src/lib.rs)\n[56] A: finished",
        memory_enabled: true,
        extraction_free: false,
    },
    {
        label: "memory disabled toggle",
        session_id: "toggle-memory-off",
        chunk_start: 99,
        session_compartments: [],
        memories: [],
        input_source: "Messages 10-11:\n\n[10] U: no durable memory please\n[11] A: ok",
        memory_enabled: false,
        extraction_free: false,
    },
    {
        label: "extraction free toggle",
        session_id: "toggle-extraction-free",
        chunk_start: 100,
        session_compartments: [],
        memories: [],
        input_source: "Messages 20-21:\n\n[20] U: rebuild structure only\n[21] A: ok",
        memory_enabled: true,
        extraction_free: true,
    },
    {
        label: "both toggles order",
        session_id: "toggle-both",
        chunk_start: 101,
        session_compartments: [],
        memories: [],
        input_source: "Messages 30-31:\n\n[30] U: structure only and memory disabled\n[31] A: ok",
        memory_enabled: false,
        extraction_free: true,
    },
    {
        label: "dreamer disabled skips user observations",
        session_id: "toggle-dreamer-off",
        chunk_start: 102,
        session_compartments: [],
        memories: [{ id: 8, category: "NAMING", content: "Dreamer-off projects keep memory" }],
        input_source: "Messages 40-41:\n\n[40] U: dreamer is off here\n[41] A: ok",
        memory_enabled: true,
        user_observations_requested: false,
        extraction_free: false,
    },
    {
        label: "dreamer disabled and memory disabled toggle order",
        session_id: "toggle-dreamer-and-memory-off",
        chunk_start: 103,
        session_compartments: [],
        memories: [],
        input_source: "Messages 50-51:\n\n[50] U: no dreamer and no memory\n[51] A: ok",
        memory_enabled: false,
        user_observations_requested: false,
        extraction_free: false,
    },
    {
        label: "dreamer disabled under extraction free adds nothing",
        session_id: "toggle-dreamer-off-extraction-free",
        chunk_start: 104,
        session_compartments: [],
        memories: [],
        input_source: "Messages 60-61:\n\n[60] U: structural rebuild with dreamer off\n[61] A: ok",
        memory_enabled: true,
        user_observations_requested: false,
        extraction_free: true,
    },
];

const seedCaseSpecs: SeedCaseSpec[] = [
    { label: "default rotation a", session_id: "rot-a", chunk_start: 0, count: 3 },
    { label: "default rotation b", session_id: "rot-b", chunk_start: 1, count: 3 },
    { label: "unicode utf16 rotation", session_id: "emoji-🚀-session", chunk_start: 7, count: 3 },
    { label: "flat fallback count above band guard", session_id: "fallback", chunk_start: 12345, count: 25 },
];

const seedCases: SeedCase[] = seedCaseSpecs.map((spec) => {
    const seeds = selectSeeds(spec.session_id, spec.chunk_start, spec.count);
    return {
        ...spec,
        selected_indices: selectedSeedIndices(spec.session_id, spec.chunk_start, spec.count),
        seed_examples: renderSeedExamplesBlock(seeds),
    };
});

const promptCases: PromptCase[] = promptCaseSpecs.map((spec) => {
    const sessionCompartments = spec.session_compartments.map(toTsCompartment);
    const refs = buildReferenceBlocks({
        sessionId: spec.session_id,
        chunkStart: spec.chunk_start,
        sessionCompartments,
    });
    const projectMemory = renderHistorianMemoryBlock(spec.memories.map(toTsMemory)) ?? "";
    const prompt = buildCompartmentAgentPrompt({
        seedExamples: refs.seedExamples,
        sessionReferences: refs.sessionReferences,
        projectMemory,
        inputSource: spec.input_source,
        memoryEnabled: spec.memory_enabled,
        userObservationsRequested: spec.user_observations_requested,
        extractionFree: spec.extraction_free,
    });
    return {
        ...spec,
        selected_seed_indices: selectedSeedIndices(spec.session_id, spec.chunk_start, 3),
        seed_examples: refs.seedExamples,
        session_references: refs.sessionReferences,
        project_memory: projectMemory,
        prompt,
    };
});

const distinctDefaultSelections = new Set(
    seedCases.filter((c) => c.count === 3).map((c) => JSON.stringify(c.selected_indices)),
);
if (distinctDefaultSelections.size <= 1) {
    throw new Error("seed rotation cases are vacuous; distinct inputs produced the same selection");
}
if (!seedCases.some((c) => c.count > 20 && c.selected_indices.length > 20)) {
    throw new Error("seed cases stopped exercising flat-corpus fallback after the band-walk guard");
}
if (!promptCases.some((c) => c.seed_examples.length > 0)) {
    throw new Error("prompt cases never emitted seeds");
}
if (!promptCases.some((c) => c.session_references.length > 0)) {
    throw new Error("prompt cases never emitted session references");
}
if (!promptCases.some((c) => c.project_memory.length > 0)) {
    throw new Error("prompt cases never emitted project memory");
}

// Boundary scores, clustered histories and Unicode ids pin band choice, tie
// rotation, no-content exclusion and every fitting suffix in both languages.
const referenceSpecs = [
    { label: "mixed recent bands", scores: [1, 9, 10, 29, 30, 59, 60, 84, 85, 100, 70, 90, 70, 90] },
    { label: "all bands covered", scores: [5, 20, 40, 70, 90, 5, 20, 40, 70, 90, 5, 20, 40, 70] },
    { label: "history lacks low bands", scores: [40, 70, 90, 40, 70, 90, 70, 70, 70, 70] },
    { label: "one older band", scores: [...Array(20).fill(40), 70, 70, 70, 70] },
    { label: "no-content gaps", scores: [5, 20, 40, 70, 90, 50, 70, 90], markers: true },
    ...Array.from({ length: 6 }, (_, count) => ({ label: `young ${count}`, scores: Array(count).fill(50) })),
];
const referenceCases = referenceSpecs.map((spec, caseIndex) => {
    const session_id = "calibration-🚀";
    const chunk_start = 42 + caseIndex;
    const session_compartments: ReferenceCompartmentJson[] = spec.scores.map((importance, i) => ({
        start_message: i * 10 + 1, end_message: i * 10 + 10,
        title: `Compartment ${i}`, content: `Body & <${i}>`, importance, episode_type: "feature",
    }));
    if ("markers" in spec && spec.markers) {
        for (const at of [session_compartments.length, 4, 0]) session_compartments.splice(at, 0, {
            start_message: 999, end_message: 999, title: "", content: "", importance: 1,
        });
    }
    const seeds = selectSeeds(session_id, chunk_start);
    const selected = selectSessionReferences(session_compartments.map(toTsCompartment), seeds, session_id, chunk_start);
    return {
        label: spec.label, session_id, chunk_start, session_compartments,
        seed_examples: renderSeedExamplesBlock(seeds),
        selected_starts: selected.map((c) => c.startMessage),
        windows: Array.from({ length: 8 }, (_, window) => ({ window, block: renderSessionReferencesBlock(selected, window) })),
    };
});
const golden = { seed_cases: seedCases, prompt_cases: promptCases, reference_cases: referenceCases };
const rendered = `${JSON.stringify(golden, null, 2)}\n`;
const outPath = join(import.meta.dir, "..", "testdata", "historian-prompt-golden.json");

if (process.argv.includes("--check")) {
    if (!existsSync(outPath)) {
        console.error(`missing historian prompt golden: ${outPath}`);
        process.exit(1);
    }
    const current = readFileSync(outPath, "utf8");
    if (current !== rendered) {
        console.error(`historian prompt golden drifted; regenerate ${outPath}`);
        process.exit(1);
    }
    console.log(`historian prompt golden up to date: ${promptCases.length} prompts, ${seedCases.length} seeds, ${referenceCases.length} reference selections: ${outPath}`);
} else {
    writeFileSync(outPath, rendered);
    console.log(`wrote ${promptCases.length} prompts + ${seedCases.length} seed cases + ${referenceCases.length} reference selections → ${outPath}`);
}
