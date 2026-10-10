/// <reference types="bun-types" />

/**
 * The checkout claim on a real host.
 *
 * A wire-level fake subc daemon plays ALF (`prefrontal-core`
 * agent.for_host_session) and engram (`agent-sync` claim.read). It maps every
 * session to one agent whose claim another machine holds. Against the real
 * OpenCode 1 server and the real Pi/OMP RPC hosts, the turn must be refused before
 * Magic Context writes anything for the session and before the provider is
 * called. Moving the claim back to this machine must let the next turn
 * through once the short refusal period has passed. lsof on the host PID
 * proves the run used only throwaway stores.
 */

import { afterAll, beforeAll, expect, it } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type FakeSubcDaemon,
    startFakeSubcDaemon,
} from "../../plugin/src/features/magic-context/checkout-claim-fake-subc.test-support";
import { inspectHostOpenFiles } from "../src/host-open-files";
import { PiTestHarness } from "../src/pi-harness";
import {
    createFreshSession,
    createScenarioHarness,
    forEachHost,
    isPiFamily,
    type ScenarioHarness,
} from "../src/scenario-hosts";
import { createE2ETempDir } from "../src/temp-dir";
import { openTestDb } from "../src/test-db";

const AGENT = "agent_checkout_e2e";
const HOLDER = "e2e0holder0machine0aa";
/** The gate re-checks a refusal after 5 s; wait just past it. */
const REFUSAL_RECHECK_WAIT_MS = 5_300;

forEachHost(import.meta.url, "checkout claim refuses a session held on another machine", (host) => {
    let h: ScenarioHarness;
    let daemon: FakeSubcDaemon;
    let heldElsewhere = true;
    let logPath: string;
    const previousLogPath = process.env.MAGIC_CONTEXT_LOG_PATH;

    const fleet = (call: { route: { target: Record<string, unknown> }; method: string; params: unknown }) => {
        if (call.route.target.module_id === "prefrontal-core" && call.method === "agent.for_host_session") {
            return { result: { agent_id: AGENT } };
        }
        if (call.route.target.module_id === "engram" && call.method === "claim.read") {
            return {
                result: heldElsewhere
                    ? { epoch: 4, held_here: false, held_elsewhere: true, holder: HOLDER }
                    : { epoch: 5, held_here: true, held_elsewhere: false, holder: "this-machine" },
            };
        }
        return { error: { code: "unknown_method", message: call.method } };
    };

    beforeAll(async () => {
        const magicContextConfig = {
            historian: { disable: true },
            dreamer: { disable: true },
            memory: { enabled: false },
        };
        if (isPiFamily(host)) {
            // Pi checks at session start, so the fleet must answer before it boots.
            const dataDir = join(createE2ETempDir("checkout-claim-pi-"), "data");
            logPath = join(dataDir, "cortexkit", "magic-context-pi.log");
            process.env.MAGIC_CONTEXT_LOG_PATH = logPath;
            daemon = await startFakeSubcDaemon(
                join(dataDir, "cortexkit", "run", "subc-connection.json"),
                fleet,
            );
            h = await createScenarioHarness(host, {
                magicContextConfig,
                sharedDataDir: dataDir,
            });
        } else {
            // OpenCode 1 checks on the first transform pass, after boot.
            h = await createScenarioHarness(host, { magicContextConfig });
            logPath = join(h.dataDir, "cortexkit", "magic-context-e2e.log");
            daemon = await startFakeSubcDaemon(
                join(h.dataDir, "cortexkit", "run", "subc-connection.json"),
                fleet,
            );
        }
    }, 180_000);

    afterAll(async () => {
        await h?.dispose();
        await daemon?.close();
        if (previousLogPath === undefined) delete process.env.MAGIC_CONTEXT_LOG_PATH;
        else process.env.MAGIC_CONTEXT_LOG_PATH = previousLogPath;
    });

    const sessionMetaRows = (sessionId: string): number => {
        if (!existsSync(h.contextDbPath())) return 0;
        // A fresh handle per read: the harness's cached one may predate the pass.
        const db = openTestDb(h.contextDbPath());
        try {
            const row = db
                .prepare("SELECT COUNT(*) AS n FROM session_meta WHERE session_id = ?")
                .get(sessionId) as { n: number };
            return row.n;
        } finally {
            db.close();
        }
    };
    // Host title generation sends the first prompt through its own request with
    // no tools and no context transform; only agent turns carry tools.
    const providerTurns = () =>
        h.mock
            .requests()
            .filter(
                (request) =>
                    Array.isArray(request.body.messages) &&
                    Array.isArray(request.body.tools) &&
                    request.body.tools.length > 0,
            ).length;
    const hostPid = (): number => {
        const handle = h as unknown as { opencode?: { pid: number }; hostPid?: number };
        const pid = handle.opencode?.pid ?? handle.hostPid;
        if (!pid) throw new Error("host PID unavailable for live-store isolation");
        return pid;
    };

    it("refuses the turn before any write, then serves it once the claim is back", async () => {
        const sessionId = await createFreshSession(h);
        const before = providerTurns();

        const refused = await h
            .sendPrompt(sessionId, "work on the moved agent", { timeoutMs: 60_000 })
            .then(
                () => "answered",
                (error: unknown) => `refused: ${String(error).slice(0, 600)}`,
            );
        console.log(`[checkout-claim e2e ${host}] held-elsewhere turn: ${refused}`);
        expect(refused).toStartWith("refused:");
        await Bun.sleep(500);
        expect(providerTurns()).toBe(before);
        expect(sessionMetaRows(sessionId)).toBe(0);

        const log = readFileSync(logPath, "utf8");
        expect(log).toContain(`checkout claim: REFUSED agent=${AGENT} is held elsewhere holder=${HOLDER} epoch=4`);
        if (h instanceof PiTestHarness) {
            expect(log).toContain("[magic-context][pi] turn refused");
            expect(log).toContain("MC-C16");
        }
        const harness = isPiFamily(host) ? "pi" : "opencode";
        const asked = daemon.calls.filter(
            (call) => (call.params as { session?: string }).session === sessionId,
        );
        expect(asked.length).toBeGreaterThan(0);
        expect(asked[0]).toMatchObject({
            method: "agent.for_host_session",
            params: { harness, session: sessionId },
            route: {
                target: { kind: "management_surface", module_id: "prefrontal-core" },
                identity: { harness, session: sessionId },
            },
        });
        expect(daemon.calls.some((call) => call.method === "claim.read" &&
            (call.params as { subject?: string }).subject === `agent:${AGENT}` &&
            call.route.target.service_id === "agent-sync")).toBe(true);

        const contained = inspectHostOpenFiles(hostPid(), realpathSync(tmpdir()));
        console.log(
            `[checkout-claim e2e ${host}] lsof pid=${contained.pid} databases=${JSON.stringify(contained.databases)}`,
        );

        // The agent comes back to this machine. After the short refusal period
        // the next turn is checked again, admitted, and served.
        heldElsewhere = false;
        await Bun.sleep(REFUSAL_RECHECK_WAIT_MS);
        await h.sendPrompt(sessionId, "the agent is back", { timeoutMs: 120_000 });
        expect(providerTurns()).toBeGreaterThan(before);
        expect(sessionMetaRows(sessionId)).toBe(1);
        expect(readFileSync(logPath, "utf8")).toContain(
            `checkout claim: admitted reason=held_here agent=${AGENT} epoch=5`,
        );
        const after = inspectHostOpenFiles(hostPid(), realpathSync(tmpdir()), h.contextDbPath());
        expect(after.databases.length).toBeGreaterThan(0);
        console.log(
            `[checkout-claim e2e ${host}] lsof pid=${after.pid} databases=${JSON.stringify(after.databases)}`,
        );
    }, 240_000);
});
