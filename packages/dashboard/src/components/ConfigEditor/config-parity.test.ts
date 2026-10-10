import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isCoveredBy, OMITTED_BY_DESIGN, RENDERED_PREFIXES } from "./config-field-coverage";

// Dashboard ⇄ plugin config-schema parity guard.
//
// The ConfigEditor form is a hand-maintained mirror of the plugin's Zod schema
// (assets/magic-context.schema.json). This test fails the build whenever the
// schema gains, renames, or removes a field that the form's coverage manifest
// (config-field-coverage.ts) doesn't account for — so the form can't silently
// drift out of sync again (the bug that left `experimental.*` rendering for a
// full release after it was graduated).
//
// Resolution is intentionally manual: a new schema field must be classified as
// either RENDERED (add a widget) or OMITTED_BY_DESIGN (raw-JSONC only, with a
// reason). The test only enforces that the decision was made.

const SCHEMA_PATH = resolve(import.meta.dir, "../../../../../assets/magic-context.schema.json");

interface JsonSchemaNode {
  properties?: Record<string, JsonSchemaNode>;
  deprecated?: boolean;
}

function loadSchema(): JsonSchemaNode {
  return JSON.parse(readFileSync(SCHEMA_PATH, "utf-8")) as JsonSchemaNode;
}

/** Every leaf path in the schema (a property with no sub-properties). */
function schemaLeaves(node: JsonSchemaNode, prefix = ""): string[] {
  const props = node.properties;
  if (!props) return [];
  const out: string[] = [];
  for (const [key, child] of Object.entries(props)) {
    if (key === "$schema") continue;
    const path = `${prefix}${key}`;
    const sub = schemaLeaves(child, `${path}.`);
    if (sub.length > 0) out.push(...sub);
    else out.push(path);
  }
  return out;
}

function deprecatedSchemaPaths(node: JsonSchemaNode, prefix = ""): string[] {
  const props = node.properties;
  if (!props) return [];
  return Object.entries(props).flatMap(([key, child]) => {
    const path = `${prefix}${key}`;
    return [...(child.deprecated ? [path] : []), ...deprecatedSchemaPaths(child, `${path}.`)];
  });
}

const OMITTED_PREFIXES = Object.keys(OMITTED_BY_DESIGN);

function classify(leaf: string): "rendered" | "omitted" | "uncovered" {
  if (RENDERED_PREFIXES.some((p) => isCoveredBy(leaf, p))) return "rendered";
  if (OMITTED_PREFIXES.some((p) => isCoveredBy(leaf, p))) return "omitted";
  return "uncovered";
}

describe("ConfigEditor ⇄ schema parity", () => {
  const leaves = schemaLeaves(loadSchema());

  it("#given the generated schema #then every leaf field is classified (rendered or omitted-by-design)", () => {
    const uncovered = leaves.filter((l) => classify(l) === "uncovered");
    // If this fails: a schema field is neither rendered by the form nor
    // listed in OMITTED_BY_DESIGN. Add a widget to ConfigEditor.tsx +
    // RENDERED_PREFIXES, or add it to OMITTED_BY_DESIGN with a reason.
    expect(uncovered).toEqual([]);
  });

  it("#given a leaf #then it is not classified as BOTH rendered and omitted", () => {
    const both = leaves.filter(
      (l) =>
        RENDERED_PREFIXES.some((p) => isCoveredBy(l, p)) &&
        OMITTED_PREFIXES.some((p) => isCoveredBy(l, p)),
    );
    expect(both).toEqual([]);
  });

  it("#given the coverage manifest #then no RENDERED prefix points at a non-existent schema field", () => {
    // Reverse drift: a prefix that matches no schema leaf means the field
    // was removed/renamed and the manifest is stale.
    const stale = RENDERED_PREFIXES.filter((p) => !leaves.some((l) => isCoveredBy(l, p)));
    expect(stale).toEqual([]);
  });

  it("#given the coverage manifest #then no OMITTED entry points at a non-existent schema field", () => {
    const stale = OMITTED_PREFIXES.filter((p) => !leaves.some((l) => isCoveredBy(l, p)));
    expect(stale).toEqual([]);
  });

  it("#given schema-deprecated ignored keys #then the form renders no control for them", () => {
    const deprecated = deprecatedSchemaPaths(loadSchema());
    expect(deprecated).toContain("protected_tags");
    expect(deprecated).toContain("smart_drops");
    expect(deprecated).toContain("mural.model");
    expect(
      deprecated.filter((leaf) =>
        RENDERED_PREFIXES.some((prefix) => isCoveredBy(leaf, prefix) || isCoveredBy(prefix, leaf)),
      ),
    ).toEqual([]);

    const source = readFileSync(resolve(import.meta.dir, "./ConfigEditor.tsx"), "utf-8");
    const renderedDeprecatedControls = deprecated.filter((leaf) =>
      // Controls may use a generic field descriptor or hand-written JSX.
      // Neither may read, write or display a deprecated setting's exact key.
      [`"${leaf}"`, `'${leaf}'`, `>${leaf}<`].some((needle) => source.includes(needle)),
    );
    expect(renderedDeprecatedControls).toEqual([]);
  });

  it("#given the graduated features #then they are NOT referenced under the dead experimental.* namespace", () => {
    // experimental.* was graduated in v0.22.0; nothing should re-introduce it.
    const experimentalRefs = [...RENDERED_PREFIXES, ...OMITTED_PREFIXES].filter((p) =>
      p.startsWith("experimental"),
    );
    expect(experimentalRefs).toEqual([]);
    expect(leaves.some((l) => l.startsWith("experimental"))).toBe(false);
  });

  it("#given the form source #then it does not read or write the dead experimental.* config namespace", () => {
    // Source-level guard: the manifest can use the right paths while the JSX
    // still reads/writes experimental.* (exactly the v0.22.0 regression).
    // The form must touch the graduated paths directly.
    const source = readFileSync(resolve(import.meta.dir, "./ConfigEditor.tsx"), "utf-8");
    const offenders = [
      'getNestedValue(formData(), "experimental")',
      '"experimental"',
      "experimental.temporal_awareness",
      "experimental.git_commit_indexing",
      "experimental.auto_search",
      "experimental.caveman_text_compression",
      "setExperimentalKey",
    ].filter((needle) => source.includes(needle));
    expect(offenders).toEqual([]);
  });
});
