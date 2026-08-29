import { writeFileSync } from "node:fs";
import { join } from "node:path";

const pluginDir = join(import.meta.dir, "..", "..", "..", "packages", "plugin");
const resolve = (module: string) => Bun.resolveSync(module, pluginDir);
const { applyEditMarkerToInput } = await import(
    resolve("./src/hooks/magic-context/edit-marker")
);

interface EditMarkerPayloadCase {
    label: string;
    input: Record<string, unknown>;
    expected: Record<string, unknown>;
    input_key_order?: string[];
    expected_json?: string;
}

const cases: EditMarkerPayloadCase[] = [
    {
        label: "edit-marker: file path verbatim and diff prefixes clamped",
        input: {
            filePath: "/workspace/packages/plugin/src/hooks/magic-context/edit-marker.ts",
            oldString: `${"a".repeat(39)}😀tail`,
            newString: "new contents ".repeat(8),
            occurrence: 2,
        },
        expected: {},
    },
    {
        label: "write-marker: path and small metadata survive",
        input: {
            path: "/workspace/crates/mc-module/src/selection.rs",
            content: "written contents ".repeat(8),
            mode: "overwrite",
        },
        expected: {},
    },
    {
        label: "edit-marker: original insertion order reaches provider serialization",
        input: {
            z: "metadata-first",
            filePath: "/workspace/z-first.ts",
            content: "replacement contents ".repeat(8),
        },
        expected: {},
    },
];

for (const fixture of cases) {
    fixture.input_key_order = Object.keys(fixture.input);
    fixture.expected = structuredClone(fixture.input);
    applyEditMarkerToInput(fixture.expected);
    fixture.expected_json = JSON.stringify(fixture.expected);
}

const outPath = join(import.meta.dir, "..", "testdata", "edit-marker-golden.json");
writeFileSync(outPath, `${JSON.stringify(cases, null, 2)}\n`);
console.log(`wrote ${cases.length} edit-marker cases → ${outPath}`);
