import { expect, test } from "bun:test";
import {
    addCodeModeEntries,
    renderCodeModeCatalog,
    replaceCodeModeCatalog,
} from "../hooks/__tests__/code-mode-catalog.fixture";
import { codeModeCatalogKind } from "./code-mode-catalog";

for (const version of ["2.0.22", "2.1.4", "2.2.3"] as const) {
    test(`recognizes initial, empty, replacement and incremental catalog text from OpenCode ${version}`, () => {
        expect(
            codeModeCatalogKind({ text: renderCodeModeCatalog(["CATALOG_ENTRY"], version) }),
        ).toBe("initial");
        expect(codeModeCatalogKind({ text: renderCodeModeCatalog([], version) })).toBe("initial");
        expect(
            codeModeCatalogKind({ text: replaceCodeModeCatalog(["CATALOG_ENTRY"], version) }),
        ).toBe("replacement");
        expect(codeModeCatalogKind({ text: replaceCodeModeCatalog([], version) })).toBe(
            "replacement",
        );
        expect(codeModeCatalogKind({ text: addCodeModeEntries(["ADDED_ENTRY"]) })).toBe(
            "incremental",
        );
    });
}

test("ordinary instructions and the invented catalog prefix are not Code Mode catalogs", () => {
    for (const text of [
        "Never deploy without permission.",
        "This catalog supersedes the previous catalog:",
        "# Code Mode unrelated heading",
    ]) {
        expect(codeModeCatalogKind({ text })).toBeUndefined();
    }
});

test("persisted instruction source keys own catalog identity, without retiring combined sources", () => {
    const text = replaceCodeModeCatalog(["CATALOG_ENTRY"]);
    expect(
        codeModeCatalogKind({
            text: "Host-keyed Code Mode catalog",
            metadata: { instructionSources: ["core/codemode"] },
        }),
    ).toBe("initial");
    expect(
        codeModeCatalogKind({
            text,
            metadata: { notice: "instructions", instructionSources: ["core/codemode"] },
        }),
    ).toBe("replacement");
    expect(
        codeModeCatalogKind({
            text,
            metadata: { instructionSources: ["core/codemode", "plugin/policy"] },
        }),
    ).toBe("combined-replacement");
    for (const instructionSources of [["plugin/policy"], [], "core/codemode"]) {
        expect(codeModeCatalogKind({ text, metadata: { instructionSources } })).toBeUndefined();
    }
});
