import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface TextFlags {
    memory: boolean;
    dreamer: boolean;
    temporal: boolean;
    caveman: boolean;
    language: boolean;
}

const texts = JSON.parse(
    readFileSync(resolve(import.meta.dir, "../../../crates/mc-module/assets/tool_catalog_v1.json"), "utf8"),
).texts as Record<string, string>;

/**
 * Reference evaluator for the GuidanceSet syntax used by the catalog assets:
 * literal includes, module-fact conditionals and verbatim values. Sharing this
 * fixture evaluator with the Rust catalog generator prevents syntax drift;
 * production rendering remains in cortexkit-persona.
 */
export function renderCatalogText(
    name: string,
    flags: TextFlags,
    values: Record<string, string>,
    templates: Record<string, string> = texts,
): string {
    const template = templates[name];
    if (template === undefined) throw new Error(`no text named ${name}`);
    let out = "";
    const open: boolean[] = [];
    const keeping = () => open.every(Boolean);
    const tokens = /\{\{([\s\S]*?)\}\}|\{%([\s\S]*?)%\}/g;
    let at = 0;
    for (const match of template.matchAll(tokens)) {
        if (keeping()) out += template.slice(at, match.index);
        at = match.index + match[0].length;
        if (match[1] !== undefined) {
            const value = /^values\.([a-z_]+)$/.exec(match[1].trim());
            if (!value?.[1] || values[value[1]] === undefined)
                throw new Error(`${name}: unknown value ${match[1]}`);
            if (keeping()) out += values[value[1]];
            continue;
        }
        const tag = match[2]?.trim();
        const condition = /^if (not )?module\.([a-z_]+)$/.exec(tag ?? "");
        const include = /^include '([a-z0-9-]+)'$/.exec(tag ?? "");
        if (condition?.[2]) {
            const flag = condition[2];
            if (!Object.hasOwn(flags, flag))
                throw new Error(`${name}: unknown flag ${flag}`);
            const on = flags[flag as keyof TextFlags];
            open.push(condition[1] ? !on : on);
        } else if (tag === "endif") {
            if (open.pop() === undefined)
                throw new Error(`${name}: endif closes nothing open`);
        } else if (include?.[1]) {
            const logicalName = Object.keys(templates).find(
                (key) => key.replace(/[/_]/g, "-") === include[1],
            );
            if (!logicalName)
                throw new Error(`${name}: unknown include ${include[1]}`);
            if (keeping()) out += renderCatalogText(logicalName, flags, values, templates);
        } else {
            throw new Error(`${name}: malformed tag ${match[0]}`);
        }
    }
    if (open.length) throw new Error(`${name}: unclosed conditional`);
    if (keeping()) out += template.slice(at);
    return out;
}

/** The enabled-feature guidance previously shipped as four separate text assets. */
export function enabledCatalogGuidance(reduce: boolean, preset: "full" | "light"): string {
    return renderCatalogText(
        `head/${reduce ? "reduce" : "no_reduce"}/${preset}`,
        { memory: true, dreamer: true, temporal: true, caveman: false, language: false },
        { language_directive: "" },
    );
}
