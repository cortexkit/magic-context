/**
 * Process-local deterministic JSON serialization for JSON-like plain
 * objects. Keys are sorted by code-point order (NOT locale-sensitive).
 *
 * Contract:
 * - Stable for plain objects, arrays, primitives, and `null`.
 * - `undefined` serialized as the string "undefined".
 * - Circular references serialized as the string `"[Circular]"`.
 * - **NOT** a canonical cross-runtime / cross-locale JSON serializer.
 *   Two different runtimes that disagree on `JSON.stringify` of primitives
 *   (none known today) would produce different output.
 *
 * Used for:
 * - `tool_definition_measurements` fingerprint hashing
 * - `pending_compaction_marker_state` CAS comparison
 *
 * If a future use case needs true canonical JSON (e.g. cross-process
 * signing), build a separate utility — do NOT widen this contract.
 */
export function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
    // Collect pieces and join once. Joining at every level copied each nested
    // value's text once per enclosing level, so a large value N levels deep cost
    // N copies of itself.
    const pieces: string[] = [];
    writeStable(value, seen, pieces);
    return pieces.join("");
}

function writeStable(value: unknown, seen: WeakSet<object>, pieces: string[]): void {
    if (value === undefined) {
        pieces.push("undefined");
        return;
    }
    if (value === null || typeof value !== "object") {
        pieces.push(JSON.stringify(value) ?? String(value));
        return;
    }
    // Any object met a second time, shared or cyclic, is written as "[Circular]".
    if (seen.has(value)) {
        pieces.push('"[Circular]"');
        return;
    }
    seen.add(value);
    if (Array.isArray(value)) {
        pieces.push("[");
        for (let index = 0; index < value.length; index += 1) {
            if (index > 0) pieces.push(",");
            // A hole writes nothing between its commas, as joining a mapped array did.
            if (index in value) writeStable(value[index], seen, pieces);
        }
        pieces.push("]");
        return;
    }
    // Code-point sort (NOT localeCompare). Stable across runtimes/locales.
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => {
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
    });
    pieces.push("{");
    entries.forEach(([key, child], index) => {
        if (index > 0) pieces.push(",");
        pieces.push(JSON.stringify(key), ":");
        writeStable(child, seen, pieces);
    });
    pieces.push("}");
}
