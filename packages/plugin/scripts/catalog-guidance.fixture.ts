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

/** Render the shared catalog's includes, runtime values and nested conditional sections. */
export function renderCatalogText(
    name: string,
    flags: TextFlags,
    values: Record<string, string>,
    templates: Record<string, string> = texts,
): string {
    const template = templates[name];
    if (template === undefined) throw new Error(`no text named ${name}`);
    let out = "";
    const open: { flag: string; keep: boolean }[] = [];
    const keeping = () => open.every((section) => section.keep);
    let at = 0;
    while (at < template.length) {
        const start = template.indexOf("{{", at);
        if (start < 0) {
            if (keeping()) out += template.slice(at);
            break;
        }
        if (keeping()) out += template.slice(at, start);
        const end = template.indexOf("}}", start + 2);
        if (end < 0) throw new Error(`${name}: unterminated tag`);
        const tag = template.slice(start + 2, end);
        at = end + 2;
        const sigil = tag[0];
        const body = tag.slice(1);
        if (sigil === "#" || sigil === "^") {
            if (!(body in flags)) throw new Error(`${name}: unknown flag ${body}`);
            const on = flags[body as keyof TextFlags];
            open.push({ flag: body, keep: sigil === "#" ? on : !on });
        } else if (sigil === "/") {
            const section = open.pop();
            if (section?.flag !== body) throw new Error(`${name}: {{/${body}}} closes nothing open`);
        } else if (sigil === "$") {
            const value = values[body];
            if (value === undefined) throw new Error(`${name}: no value ${body}`);
            if (keeping()) out += value;
        } else if (/^[a-z_/]+$/.test(tag)) {
            if (keeping()) out += renderCatalogText(tag, flags, values, templates);
        } else {
            throw new Error(`${name}: malformed tag {{${tag}}}`);
        }
    }
    if (open.length > 0) throw new Error(`${name}: section ${open[0]?.flag} is never closed`);
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
