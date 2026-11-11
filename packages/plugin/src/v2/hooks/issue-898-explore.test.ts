import { afterAll, afterEach, spyOn, test } from "bun:test";
import * as inject from "../../hooks/magic-context/inject-compartments";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";

const options = {
    area: "issue-898",
    instructions: false,
    temporal: false,
    cacheTtl: "never",
};

const statuses: string[] = [];
const real = inject.injectM0M1;
const spy = spyOn(inject, "injectM0M1").mockImplementation(((...args: Parameters<typeof real>) => {
    const result = real(...args);
    statuses.push(String(result.prefixTrimStatus));
    return result;
}) as typeof real);
afterEach(() => {
    statuses.length = 0;
});

const interesting = (logs: string[]) =>
    logs.filter((line) =>
        /prefix trim|history boundary|v2 restore|v2 host fold|refus|Unresolved|native/.test(line),
    );

type F = Awaited<ReturnType<typeof oc2ContextFixture>>;
async function step(f: F, label: string, out: unknown[]) {
    const before = statuses.length;
    const logStart = f.sessionLogs().length;
    let ids = "";
    let error: string | null = null;
    try {
        const served = await f.pass();
        ids = served.draft.messages.map((m) => `${m.role}:${m.id ?? "-"}`).join(" ");
    } catch (caught) {
        error = String(caught);
    }
    out.push({
        label,
        statuses: statuses.slice(before),
        error,
        ids,
        logs: interesting(f.sessionLogs().slice(logStart)).map((line) => line.slice(0, 400)),
    });
}

const tool = (n: number) => ({
    name: "read",
    input: { path: `src/file-${n}.ts` },
    output: `contents ${n} `.repeat(40),
});

type Variant = {
    name: string;
    fold: "native" | "manual" | "legacy" | "none";
    foldAfterUser?: boolean;
    unservedBoundary?: boolean;
    instructions?: boolean;
    host?: "2.0.22" | "2.1.0";
    windowRows?: number;
};
const variants: Variant[] = [
    { name: "idle-fold", fold: "native" },
    { name: "manual-fold", fold: "manual" },
    { name: "legacy-fold", fold: "legacy" },
    { name: "no-fold", fold: "none" },
    { name: "auto-fold-after-user", fold: "native", foldAfterUser: true },
    { name: "manual-fold-after-user", fold: "manual", foldAfterUser: true },
    { name: "legacy-fold-after-user", fold: "legacy", foldAfterUser: true },
    { name: "unserved-boundary-no-fold", fold: "none", unservedBoundary: true },
    { name: "unserved-boundary-native", fold: "native", unservedBoundary: true, foldAfterUser: true },
    { name: "instructions-native", fold: "native", instructions: true, foldAfterUser: true },
    { name: "legacy-210-kept", fold: "legacy", host: "2.1.0", foldAfterUser: true },
];

for (const [index, variant] of variants.entries()) {
    test(`explore: ${variant.name}`, async () => {
        const f = await oc2ContextFixture(89800 + index, {
            ...options,
            instructions: variant.instructions ?? false,
            host: variant.host ?? "2.0.22",
        });
        const out: unknown[] = [];
        let unserved: string | undefined;
        const step2 = async (label: string) => {
            if (!unserved) return step(f, label, out);
            const id = unserved;
            const before = statuses.length;
            const logStart = f.sessionLogs().length;
            let ids = "";
            let error: string | null = null;
            try {
                const served = await f.pass((draft) => {
                    draft.messages = draft.messages.filter((message) => message.id !== id);
                });
                ids = served.draft.messages.map((m) => `${m.role}:${m.id ?? "-"}`).join(" ");
            } catch (caught) {
                error = String(caught);
            }
            out.push({
                label,
                statuses: statuses.slice(before),
                error,
                ids,
                logs: interesting(f.sessionLogs().slice(logStart)).map((line) => line.slice(0, 400)),
            });
        };
        try {
            f.user("Look at the files.", 1000);
            for (let n = 0; n < 4; n++) f.respondWithTool(tool(n));
            if (variant.unservedBoundary) {
                // An assistant step that produced nothing (an interrupted or failed
                // step): stored, but the host renders no message for it.
                f.respond();
                f.rows.at(-1)!.text = "";
                unserved = f.rows.at(-1)!.id;
            }
            f.respond();
            const boundaryIndex = unserved
                ? f.rows.findIndex((row) => row.id === unserved)
                : f.rows.findIndex((row) => row.tool && row.text.includes("step")) + 2;
            f.compartment(boundaryIndex);
            await step2("first");
            f.user("Continue.", 1000);
            f.respondWithTool(tool(10));
            await step2("second");
            const doFold = async () => {
                if (variant.fold === "native") await f.nativeFold(3);
                if (variant.fold === "manual") await f.nativeFold(3, 0, "", "manual");
                if (variant.fold === "legacy") await f.fold(variant.windowRows ?? 3);
            };
            if (variant.foldAfterUser) {
                f.user("After the fold.", 1000);
                await doFold();
            } else {
                await doFold();
                f.user("After the fold.", 1000);
            }
            await step2("after-fold-1");
            f.respondWithTool(tool(20));
            await step2("after-fold-2");
            f.respond();
            f.user("Next.", 1000);
            await step2("after-fold-3");
            console.log(
                `ISSUE898 ${variant.name} boundary=${f.rows[boundaryIndex]!.id} ${JSON.stringify(out, null, 1)}`,
            );
        } finally {
            await f.cleanup();
        }
    }, 120000);
}

afterAll(() => spy.mockRestore());
