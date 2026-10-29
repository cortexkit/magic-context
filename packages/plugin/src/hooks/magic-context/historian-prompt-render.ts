/** Select the XML or combined output-contract sections from the editable historian source. */
export function renderHistorianSystemPrompt(source: string, contract: "xml" | "combined"): string {
    return source
        .replace(
            /<!-- historian:(xml|combined):start -->\n([\s\S]*?)\n<!-- historian:\1:end -->\n?/g,
            (_section, kind: string, content: string) => (kind === contract ? `${content}\n` : ""),
        )
        .trimEnd();
}
