import { describe, expect, test } from "bun:test";
import {
    HiddenCompletionRefusal,
    type HiddenRunIdentity,
} from "../../hooks/magic-context/compartment-runner-types";
import { childCreateInput } from "../hidden-child-record";
import {
    HiddenChildHook,
    hiddenAgentAllowedTools,
    hiddenChildPermissions,
    hiddenToolCallRefusal,
    registerHiddenChildAgents,
} from "./hidden-child";
import type { SessionContext } from "./types";

const MAPPER = "dreamer-memory-mapper";

function draft(sessionID: string, agent: string, text: string): SessionContext {
    return {
        sessionID,
        agent,
        model: { providerID: "mock", id: "cheap" },
        system: [],
        tools: { read: { description: "", input: {} }, edit: { description: "", input: {} } },
        options: {},
        messages: [{ role: "user", content: [{ type: "text", text }] }],
    } as SessionContext;
}

const mapIdentity: HiddenRunIdentity = {
    parentSessionId: "user-session",
    agent: MAPPER,
    kind: "dreamer-task",
    system: "map system",
    model: "mock/cheap",
    configuredModels: ["mock/cheap"],
    timeoutMs: 1000,
    title: "map",
    directory: "/project",
};

describe("a hidden-agent session this instance did not register", () => {
    // OpenCode 2 runs a session's hooks in the plugin instance of the session's
    // location. A child created by another instance arrives here carrying only
    // its bare run marker; passing it on sends the marker to the model with the
    // tools the user's permissions allow.
    test("is refused before the provider with hidden_prompt_unrecognized, for every hidden agent id", () => {
        for (const agent of [
            "historian",
            "dreamer-classifier",
            "dreamer",
            MAPPER,
            "dreamer-primer-investigator",
            "dreamer-retrospective",
        ]) {
            const lines: string[] = [];
            const hook = new HiddenChildHook((line) => lines.push(line));
            let caught: unknown;
            try {
                hook.apply(draft("ses_foreign", agent, "mc:hidden:aaaa:bbbb"));
            } catch (error) {
                caught = error;
            }
            expect(caught).toBeInstanceOf(HiddenCompletionRefusal);
            expect((caught as HiddenCompletionRefusal).code).toBe("hidden_prompt_unrecognized");
            expect(lines.join("\n")).toContain("did not register");
        }
    });

    test("is refused when the host compacts it, rather than summarized", () => {
        const hook = new HiddenChildHook(() => {});
        expect(() => hook.compactionSummary("ses_foreign", MAPPER)).toThrow(
            "hidden_prompt_unrecognized",
        );
    });

    test("leaves an ordinary user session to the managed pass", () => {
        const hook = new HiddenChildHook(() => {});
        expect(hook.apply(draft("ses_user", "build", "hello"))).toBe(false);
        expect(hook.compactionSummary("ses_user", "build")).toBeUndefined();
    });
});

describe("the hidden-child tool guard", () => {
    test("refuses every tool outside the hidden agent's allowlist, whatever the user allows", () => {
        const hook = new HiddenChildHook(() => {});
        for (const tool of ["edit", "write", "shell", "bash", "webfetch", "ctx_memory"]) {
            expect(
                hiddenToolCallRefusal({ tool, sessionID: "ses_x", agent: MAPPER }, hook),
            ).toContain(`${tool} refused`);
        }
        // A registered child is judged by the agent it was created with, not the
        // agent the call reports.
        hook.registerChild("ses_child", "historian");
        expect(
            hiddenToolCallRefusal({ tool: "read", sessionID: "ses_child", agent: MAPPER }, hook),
        ).toContain("read refused");
    });

    test("lets a hidden agent use exactly its own allowlist", () => {
        const hook = new HiddenChildHook(() => {});
        for (const tool of ["read", "grep", "glob"]) {
            expect(
                hiddenToolCallRefusal({ tool, sessionID: "ses_x", agent: MAPPER }, hook),
            ).toBeUndefined();
        }
        // The curator's only tool is ctx_memory.
        expect(
            hiddenToolCallRefusal(
                { tool: "ctx_memory", sessionID: "ses_x", agent: "dreamer" },
                hook,
            ),
        ).toBeUndefined();
    });

    test("refuses every tool on a registered child whose agent is unknown", () => {
        const hook = new HiddenChildHook(() => {});
        hook.registerChild("ses_child");
        expect(
            hiddenToolCallRefusal({ tool: "read", sessionID: "ses_child", agent: "build" }, hook),
        ).toContain("no tool allowlist");
    });

    test("never touches an ordinary session", () => {
        const hook = new HiddenChildHook(() => {});
        expect(
            hiddenToolCallRefusal({ tool: "edit", sessionID: "ses_user", agent: "build" }, hook),
        ).toBeUndefined();
        expect(hiddenAgentAllowedTools("build")).toBeUndefined();
        expect(hiddenAgentAllowedTools("toString")).toBeUndefined();
    });
});

describe("hidden-child permission rules", () => {
    test("deny everything first, then allow only the agent's own tools", () => {
        expect(hiddenChildPermissions(MAPPER)).toEqual([
            { action: "*", resource: "*", effect: "deny" },
            { action: "read", resource: "*", effect: "allow" },
            { action: "grep", resource: "*", effect: "allow" },
            { action: "glob", resource: "*", effect: "allow" },
        ]);
    });

    // OpenCode 2 evaluates agent rules then session rules, last match wins, and
    // appends the user's global rules to every agent after plugins run. Only
    // session rules come after the user's, so the child carries them too.
    test("are written onto the child session as well as the agent", async () => {
        const input = childCreateInput(mapIdentity, "dreamer", {
            providerID: "mock",
            modelID: "cheap",
        });
        expect(input.agent).toBe(MAPPER);
        expect(input.permissions).toEqual(hiddenChildPermissions(MAPPER));

        const registered = new Map<string, { permissions: unknown }>();
        await registerHiddenChildAgents({
            transform: async (callback) => {
                callback({
                    update: (id: string, update: (config: never) => void) => {
                        const config = { request: {}, permissions: [] } as never;
                        update(config);
                        registered.set(id, config);
                    },
                } as never);
            },
        } as never);
        expect(registered.get(MAPPER)?.permissions).toEqual(hiddenChildPermissions(MAPPER));
    });
});
