import { describe, expect, it } from "bun:test";
import { runDreamerSetup } from "./dreamer-setup";
import type { PromptIO, PromptLog, PromptSpinner, SelectOption } from "./prompts";

/** Minimal scripted PromptIO: confirms/selects/texts are FIFO queues. */
class MockPrompts implements PromptIO {
    private confirms: boolean[];
    private selects: string[];
    private texts: string[];
    private autos: string[];
    readonly notes: string[] = [];
    log: PromptLog = {
        info: () => {},
        success: () => {},
        warn: () => {},
        error: () => {},
        message: () => {},
        step: () => {},
    };

    constructor(opts: {
        confirms?: boolean[];
        selects?: string[];
        texts?: string[];
        autos?: string[];
    }) {
        this.confirms = [...(opts.confirms ?? [])];
        this.selects = [...(opts.selects ?? [])];
        this.texts = [...(opts.texts ?? [])];
        this.autos = [...(opts.autos ?? [])];
    }
    intro(): void {}
    outro(): void {}
    note(message: string, title?: string): void {
        this.notes.push(`${title ?? ""}:${message}`);
    }
    spinner(): PromptSpinner {
        return { start: () => {}, stop: () => {}, message: () => {} };
    }
    async confirm(): Promise<boolean> {
        const v = this.confirms.shift();
        if (v === undefined) throw new Error("no confirm queued");
        return v;
    }
    async text(): Promise<string> {
        return this.texts.shift() ?? "";
    }
    async selectOne(_message: string, options: SelectOption[]): Promise<string> {
        const v = this.selects.shift();
        if (v !== undefined) return v;
        const rec = options.find((o) => o.recommended);
        return (rec ?? options[0]).value;
    }
    async selectMany(): Promise<string[]> {
        return [];
    }
    async selectAutocomplete(_message: string, options: SelectOption[]): Promise<string> {
        const v = this.autos.shift();
        if (v !== undefined) return v;
        return options[0]?.value ?? "";
    }
}

describe("runDreamerSetup", () => {
    it("recommended-defaults path returns model and NO tasks (schema defaults apply)", async () => {
        const prompts = new MockPrompts({
            confirms: [true], // useRecommendedSchedules = yes
            autos: ["anthropic/claude-haiku-4-5"], // dreamer model pick
        });
        const result = await runDreamerSetup(prompts, ["anthropic/claude-haiku-4-5"]);
        expect(result.model).toBe("anthropic/claude-haiku-4-5");
        expect(result.tasks).toBeUndefined();
    });

    it("declining defaults runs the per-task loop and writes every task's schedule", async () => {
        // useRecommendedSchedules = NO, then one preset select per task (all "Nightly").
        const prompts = new MockPrompts({
            confirms: [false],
            autos: ["x/y"],
            selects: Array(13).fill("cron:0 3 * * *"),
        });
        const result = await runDreamerSetup(prompts, ["x/y"]);
        expect(result.tasks).toBeDefined();
        expect(Object.keys(result.tasks ?? {}).length).toBe(13);
        expect(result.tasks?.verify.schedule).toBe("0 3 * * *");
        expect(result.tasks?.curate.schedule).toBe("0 3 * * *");
        expect(result.tasks?.["classify-memories"].schedule).toBe("0 3 * * *");
        expect(result.tasks?.retrospective.schedule).toBe("0 3 * * *");
        expect(result.tasks?.["promote-primers"].schedule).toBe("0 3 * * *");
        expect(result.tasks?.["refresh-primers"].schedule).toBe("0 3 * * *");
    });

    it("Disabled preset writes an empty schedule", async () => {
        const prompts = new MockPrompts({
            confirms: [false],
            autos: ["x/y"],
            // all disabled
            selects: Array(11).fill("cron:"),
        });
        const result = await runDreamerSetup(prompts, ["x/y"]);
        expect(result.tasks?.verify.schedule).toBe("");
        expect(result.tasks?.curate.schedule).toBe("");
        expect(result.tasks?.["maintain-docs"].schedule).toBe("");
    });

    it("Custom preset drops to validated raw-cron text entry", async () => {
        // First task picks Custom → text entry; rest pick Nightly.
        const prompts = new MockPrompts({
            confirms: [false],
            autos: ["x/y"],
            selects: ["__custom__", ...Array(10).fill("cron:0 3 * * *")],
            texts: ["30 4 * * 1"],
        });
        const result = await runDreamerSetup(prompts, ["x/y"]);
        // First task in canonical order is map-memories — Custom applies to it.
        expect(result.tasks?.["map-memories"].schedule).toBe("30 4 * * 1");
    });
});
