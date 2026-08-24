#!/usr/bin/env bun
/**
 * Generates the docs-site configuration reference page from the Zod config
 * schema — the same single source of truth as build-schema.ts, so the rendered
 * docs can never drift from runtime validation.
 *
 * Walks the JSON Schema produced by buildSchema() (draft-7, input shape) and
 * emits one Markdown section per top-level key with a table of leaf fields:
 * dotted path, type, default, and the `.describe()` text.
 *
 * Run: bun packages/plugin/scripts/build-config-docs.ts
 * Output: packages/docs/src/content/docs/reference/configuration.md
 */

import * as path from "node:path";
import { buildSchema } from "./build-schema";

type JsonSchema = {
    type?: string | string[];
    description?: string;
    default?: unknown;
    enum?: unknown[];
    properties?: Record<string, JsonSchema>;
    additionalProperties?: JsonSchema | boolean;
    anyOf?: JsonSchema[];
    oneOf?: JsonSchema[];
    items?: JsonSchema;
    minimum?: number;
    maximum?: number;
};

interface LeafRow {
    path: string;
    type: string;
    def: string;
    description: string;
}

function typeLabel(s: JsonSchema): string {
    if (s.enum) return s.enum.map((v) => `\`${JSON.stringify(v)}\``).join(" \\| ");
    const variants = s.anyOf ?? s.oneOf;
    if (variants) {
        const labels = variants.map(typeLabel);
        return [...new Set(labels)].join(" \\| ");
    }
    if (s.type === "array") return `${s.items ? typeLabel(s.items) : "unknown"}[]`;
    if (s.type === "object" && s.additionalProperties && s.additionalProperties !== true) {
        return `map<string, ${typeLabel(s.additionalProperties as JsonSchema)}>`;
    }
    if (Array.isArray(s.type)) return s.type.join(" \\| ");
    let label = s.type ?? "unknown";
    if (s.minimum !== undefined || s.maximum !== undefined) {
        const lo = s.minimum !== undefined ? `${s.minimum}` : "";
        const hi = s.maximum !== undefined ? `${s.maximum}` : "";
        label += ` (${lo}–${hi})`;
    }
    return label;
}

function defaultLabel(s: JsonSchema): string {
    if (s.default === undefined) return "—";
    return `\`${JSON.stringify(s.default)}\``;
}

function escapeCell(text: string): string {
    return text.replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}

/** Flattens nested object properties into dotted-path leaf rows. */
function collectLeaves(schema: JsonSchema, prefix: string, rows: LeafRow[]): void {
    const props = schema.properties;
    if (!props || Object.keys(props).length === 0) {
        rows.push({
            path: prefix,
            type: typeLabel(schema),
            def: defaultLabel(schema),
            description: schema.description ?? "",
        });
        return;
    }
    for (const [key, child] of Object.entries(props)) {
        const childPath = prefix ? `${prefix}.${key}` : key;
        // Objects with their own properties recurse; everything else is a leaf.
        if (child.properties && Object.keys(child.properties).length > 0) {
            // Emit a group row when the object itself carries a description.
            if (child.description) {
                rows.push({
                    path: childPath,
                    type: "object",
                    def: "—",
                    description: child.description,
                });
            }
            collectLeaves(child, childPath, rows);
        } else {
            rows.push({
                path: childPath,
                type: typeLabel(child),
                def: defaultLabel(child),
                description: child.description ?? "",
            });
        }
    }
}

const SECTION_ORDER: Array<{ keys: string[]; title: string; intro: string }> = [
    {
        keys: [
            "enabled",
            "allow_home_project",
            "language",
            "auto_update",
            "keep_subagents",
            "todowrite",
            "mural",
        ],
        title: "Top-level switches",
        intro: "Global on/off switches for the plugin and its agent-facing surface.",
    },
    {
        keys: ["prompt_surface"],
        title: "Prompt surface",
        intro: "Select the full or light built-in prompt preset. Model routes use the same progressive lookup walk as `cache_ttl`, with literal case-sensitive `provider/model` keys and the `provider/*` wildcard; guidance and tool-description overrides are user-level only.",
    },
    {
        keys: [
            "cache_ttl",
            "output_reserve",
            "execute_threshold_percentage",
            "execute_threshold_tokens",
            "protected_tags",
            "clear_reasoning_age",
            "history_budget_percentage",
        ],
        title: "Context management",
        intro: "When and how aggressively Magic Context manages the session's context window. Per-model keys accept `provider/model` map form where noted.",
    },
    {
        keys: ["profile", "profiles"],
        title: "Model profiles",
        intro: "Named user-owned model-selection overlays. A project may select a profile name but cannot define or alter profile contents.",
    },
    {
        keys: ["historian", "historian_timeout_ms", "commit_cluster_trigger"],
        title: "Historian",
        intro: "The background agent that condenses old conversation into compact history.",
    },
    {
        keys: ["memory", "embedding"],
        title: "Memory & recall",
        intro: "Durable project memory, semantic search, and recall features.",
    },
    {
        keys: ["dreamer", "sidekick"],
        title: "Background agents",
        intro: "Off-hours maintenance (Dreamer) and on-demand prompt augmentation (Sidekick).",
    },
    {
        keys: [
            "temporal_awareness",
            "caveman_text_compression",
            "system_prompt_injection",
            "sqlite",
            "storage",
        ],
        title: "Advanced",
        intro: "Behavior tuning most installs never need to touch.",
    },
];

function renderTable(rows: LeafRow[]): string {
    const header = "| Key | Type | Default | Description |\n|---|---|---|---|";
    const body = rows
        .map(
            (r) =>
                `| \`${r.path}\` | ${escapeCell(r.type)} | ${escapeCell(r.def)} | ${escapeCell(r.description)} |`,
        )
        .join("\n");
    return `${header}\n${body}`;
}

// Developer-only keys excluded from the public reference. They stay in the
// generated JSON schema (so editors validate them) but are not user-facing
// features; documenting them would invite support questions about internal
// tooling that requires a local daemon setup users do not have.
const DEV_ONLY_KEYS = new Set<string>([
    "shadow_embedding",
    // Unsupported until the fleet stack ships publicly: activating it requires a
    // subc daemon no public install has, and documenting it would let the dev
    // gate calcify into a de-facto public mode before the cutover release.
    "transform_mode",
]);

export function buildConfigDocs(): string {
    const schema = buildSchema() as JsonSchema;
    const props = schema.properties ?? {};

    const covered = new Set<string>(["$schema", ...DEV_ONLY_KEYS]);
    const sections: string[] = [];

    for (const section of SECTION_ORDER) {
        const rows: LeafRow[] = [];
        for (const key of section.keys) {
            const child = props[key];
            if (!child) continue;
            covered.add(key);
            if (child.properties && Object.keys(child.properties).length > 0) {
                if (child.description) {
                    rows.push({
                        path: key,
                        type: "object",
                        def: "—",
                        description: child.description,
                    });
                }
                collectLeaves(child, key, rows);
            } else {
                rows.push({
                    path: key,
                    type: typeLabel(child),
                    def: defaultLabel(child),
                    description: child.description ?? "",
                });
            }
        }
        if (rows.length > 0) {
            sections.push(`## ${section.title}\n\n${section.intro}\n\n${renderTable(rows)}`);
        }
    }

    // Drift guard: any top-level schema key not covered by SECTION_ORDER lands
    // in a trailing section so new config fields are never silently missing
    // from the docs (and the parity test can assert coverage).
    const uncovered = Object.keys(props).filter((k) => !covered.has(k));
    if (uncovered.length > 0) {
        const rows: LeafRow[] = [];
        for (const key of uncovered) {
            collectLeaves(props[key] as JsonSchema, key, rows);
        }
        sections.push(`## Other\n\n${renderTable(rows)}`);
    }

    return `---
title: Configuration
description: Every magic-context.jsonc key, with types, defaults, and where to put the file.
---

<!-- GENERATED FILE — do not edit. Source of truth is the Zod schema in
    packages/plugin/src/config/schema/magic-context.ts; regenerate with
    \`bun packages/plugin/scripts/build-config-docs.ts\`. -->

Magic Context reads \`magic-context.jsonc\` (or \`.json\`) from one shared CortexKit location across OpenCode, Pi, and OMP. Project config overrides user config, key by key. Prompt-surface routing is shared by all three harnesses; project config may select \`default\` and \`models\`, while \`guidance_override_path\` and \`tool_descriptions\` are stripped at the project trust boundary.

- **Project** — \`<project>/.cortexkit/magic-context.jsonc\`
- **User-wide** — \`~/.config/cortexkit/magic-context.jsonc\`

Upgrading from an earlier version moves your existing config here automatically on first run (a \`.MOVED_READPLEASE\` breadcrumb is left at the old per-harness path).

Add the schema line for editor validation and autocomplete:

\`\`\`jsonc
{
  "$schema": "https://raw.githubusercontent.com/cortexkit/magic-context/master/assets/magic-context.schema.json"
}
\`\`\`

:::note
Project-level configs cannot use \`{env:VAR}\` / \`{file:path}\` expansion. A cloned repository also cannot set \`output_reserve\`, \`sqlite.*\`, \`storage.enforce_private_permissions\`, hidden-agent prompts/permissions, \`historian.model\`, or \`historian.fallback_models\`. Profile definitions in \`profiles\` are user-level only; a project may set only \`profile\` to choose a named user profile. Project \`execute_threshold_percentage\` / \`execute_threshold_tokens\` may only RAISE thresholds relative to the user's effective settings (a repo may delay compaction, not make it happen earlier). Dreamer model/schedule/task tuning and \`memory.enabled\` remain allowed project overrides.
:::

${sections.join("\n\n")}
`;
}

async function main() {
    const rootDir = path.resolve(import.meta.dir, "..", "..", "..");
    const outputPath = path.join(
        rootDir,
        "packages",
        "docs",
        "src",
        "content",
        "docs",
        "reference",
        "configuration.md",
    );
    await Bun.write(outputPath, buildConfigDocs());
    console.log(`✓ Config reference generated: ${outputPath}`);
}

if (import.meta.main) {
    void main();
}
