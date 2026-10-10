import { describe, expect, test } from "bun:test";
import { providerMessageSource, publishMessages } from "./opencode-adapter";

// The copy `publishMessages` made before it switched to plain loops, kept here
// verbatim as the reference the current copy must reproduce.
function referenceCopy<T>(value: T): T {
    if (Array.isArray(value)) return value.map(referenceCopy) as T;
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value)
                .filter(([key, entry]) => key !== "toJSON" || typeof entry !== "function")
                .map(([key, entry]) => [key, referenceCopy(entry)]),
        ) as T;
    }
    return value;
}

// Structural identity that `toEqual` does not check: prototypes, own keys in
// order (including an own `__proto__` key), array holes and exact values.
function sameShape(left: unknown, right: unknown, path = "$"): string | undefined {
    if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
        return Object.is(left, right) ? undefined : `${path}: ${String(left)} !== ${String(right)}`;
    }
    if (Array.isArray(left) !== Array.isArray(right)) return `${path}: array kind differs`;
    if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right))
        return `${path}: prototype differs`;
    if (Array.isArray(left) && Array.isArray(right)) {
        if (left.length !== right.length)
            return `${path}: length ${left.length} !== ${right.length}`;
        for (let index = 0; index < left.length; index++) {
            if (index in left !== index in right) return `${path}[${index}]: hole differs`;
            const nested = sameShape(left[index], right[index], `${path}[${index}]`);
            if (nested) return nested;
        }
    }
    const leftKeys = Reflect.ownKeys(left);
    const rightKeys = Reflect.ownKeys(right);
    if (JSON.stringify(leftKeys.map(String)) !== JSON.stringify(rightKeys.map(String))) {
        return `${path}: keys ${leftKeys.map(String)} !== ${rightKeys.map(String)}`;
    }
    for (const key of leftKeys) {
        if (Array.isArray(left) && key !== "length" && /^\d+$/.test(String(key))) continue;
        if (key === "length" && Array.isArray(left)) continue;
        const nested = sameShape(
            (left as Record<PropertyKey, unknown>)[key],
            (right as Record<PropertyKey, unknown>)[key],
            `${path}.${String(key)}`,
        );
        if (nested) return nested;
    }
    return undefined;
}

class Wrapped {
    kept = "own field";
    method(): string {
        return "prototype method";
    }
}

function fixtures(): unknown[] {
    const sparse: unknown[] = [];
    sparse[2] = { type: "text", text: "after two holes" };
    const extra = Object.assign([{ type: "text", text: "a" }], { extra: "array property" });
    return [
        {
            info: { id: "m-tojson", role: "assistant", time: { created: 1 } },
            parts: [
                {
                    type: "text",
                    text: "serializer method",
                    toJSON() {
                        throw new Error("toJSON must not be called");
                    },
                },
                { type: "text", text: "data toJSON", toJSON: "kept as data" },
            ],
        },
        JSON.parse(
            '{"__proto__":{"polluted":true},"info":{"id":"m-proto","__proto__":[1,2]},"parts":[{"type":"text","__proto__":null}]}',
        ),
        { info: { id: "m-sparse" }, parts: sparse },
        { info: { id: "m-extra" }, parts: extra },
        {
            info: { id: "m-undefined", model: undefined },
            parts: [undefined, { type: "text", text: undefined }],
        },
        { info: { id: "m-date", time: new Date(0) }, parts: [] },
        {
            info: { id: "m-nested" },
            parts: [
                {
                    type: "tool",
                    state: {
                        status: "completed",
                        input: { path: "a", deep: [[{ x: 1 }], []] },
                        output: "o",
                    },
                },
            ],
        },
        {
            info: {
                id: "m-objects",
                map: new Map([["k", 1]]),
                set: new Set([1]),
                wrapped: new Wrapped(),
            },
            parts: [null, 0, "", false],
        },
        Object.assign(Object.create(null), { info: { id: "m-null-proto" }, parts: [] }),
    ];
}

describe("publishMessages plain-loop copy matches the previous deep copy", () => {
    test("every fixture publishes the same shape the reference copy produced", () => {
        const managed = fixtures();
        const output = { messages: ["stale"] as unknown[] };
        const host = output.messages;
        publishMessages(output, managed as never);
        expect(output.messages).toBe(host);
        expect(output.messages).toHaveLength(managed.length);
        for (let index = 0; index < managed.length; index++) {
            const difference = sameShape(output.messages[index], referenceCopy(managed[index]));
            expect(difference).toBeUndefined();
            expect(providerMessageSource(output.messages[index] as never)).toBe(
                managed[index] as never,
            );
        }
    });

    test("an own __proto__ key stays data and never changes the copy's prototype", () => {
        const [source] = [
            JSON.parse('{"__proto__":{"polluted":true},"info":{"id":"p"},"parts":[]}'),
        ];
        const output = { messages: [] as unknown[] };
        publishMessages(output, [source] as never);
        const copy = output.messages[0] as Record<string, unknown>;
        expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
        expect(Object.hasOwn(copy, "__proto__")).toBe(true);
        expect((copy as { polluted?: unknown }).polluted).toBeUndefined();
        expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    });

    test("mutating a published copy, at any depth, leaves the source untouched", () => {
        const managed = fixtures();
        const before = JSON.stringify(referenceCopy(managed));
        const output = { messages: [] as unknown[] };
        publishMessages(output, managed as never);
        const nested = output.messages[6] as {
            parts: { state: { input: { deep: { x: number }[][] } } }[];
        };
        nested.parts[0]!.state.input.deep[0]![0]!.x = 99;
        (output.messages[0] as { info: { id: string } }).info.id = "edited";
        (output.messages[2] as { parts: unknown[] }).parts.push("appended");
        expect(JSON.stringify(referenceCopy(managed))).toBe(before);
    });
});
