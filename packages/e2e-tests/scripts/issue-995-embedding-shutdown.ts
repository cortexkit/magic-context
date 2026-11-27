// Reproduction for issue 995: Pi aborting on exit while the local embedding
// worker runs a native inference ("terminate called after throwing an instance
// of 'Napi::Error'", exit code 134).
//
// This is a manual reproduction, not a CI test: it needs the real
// Xenova/all-MiniLM-L6-v2 model (downloaded with network access) and, for the
// Node arm, Node itself. Run it through issue-995-embedding-shutdown.sh, which
// downloads Node and the model into a throwaway directory, builds the Pi plugin
// and bundles this file into packages/pi-plugin/dist, so the embedding worker
// client loads the built dist/embedding-worker.js exactly as the shipped plugin
// does. Every store, configuration and model cache it touches is under the
// runner's throwaway root.
//
// Usage (after bundling): <node|bun> issue-995-driver.js <mode> <project dir> [delay ms] [texts]
// Modes:
//   pi-shutdown  start a 48-text inference, wait `delay`, then run Pi's
//                session_shutdown embedding step and call process.exit(0) as Pi does
//   retire       the same, but first retire the live provider through observation
//                mode, as a configuration change during the session would
//   exit         start the inference, wait, then process.exit(0) with no disposal
//                (an exit nobody prepared for)
//   measure      run the inference to the end and report how long it took
//   natural-exit embed once, start the disposal without waiting for it and return
//                without process.exit; reports how long the process lived after that
//   yield-cost   time one setImmediate round trip (the loop's yield between batches)
import { writeSync } from "node:fs";
import * as bootstrap from "../../pi-plugin/src/embedding-bootstrap";
import { resolveProjectIdentityForSession } from "../../plugin/src/features/magic-context/memory/project-identity";
import {
    embedBatchForProject,
    registerProjectInObservationMode,
} from "../../plugin/src/features/magic-context/project-embedding-registry";
import { openDatabase } from "../../plugin/src/features/magic-context/storage";
import { setHarness } from "../../plugin/src/shared/harness";
import { flushLogger } from "../../plugin/src/shared/logger";

const [mode = "measure", projectDir = "", delayArg = "300", countArg = "48"] =
    process.argv.slice(2);
const say = (line: string) => writeSync(1, `${line}\n`);

if (mode === "yield-cost") {
    const rounds = 20_000;
    for (let warm = 0; warm < 1_000; warm++) await new Promise((r) => setImmediate(r));
    const started = performance.now();
    for (let round = 0; round < rounds; round++) await new Promise((r) => setImmediate(r));
    say(`YIELD_COST us=${(((performance.now() - started) / rounds) * 1000).toFixed(2)}`);
    process.exit(0);
}

// Pi's session_shutdown embedding step. Builds without it (before the fix)
// only had unregisterPiProjectEmbeddings, which did not wait.
const shutdownEmbeddings =
    ((bootstrap as Record<string, unknown>).shutdownPiProjectEmbeddings as
        | ((db: unknown) => Promise<void>)
        | undefined) ?? bootstrap.unregisterPiProjectEmbeddings;

setHarness("pi");
const db = openDatabase();
if (!db) throw new Error("no database");
await bootstrap.ensureProjectRegisteredFromPiDirectory(projectDir, db);
const identity = resolveProjectIdentityForSession(projectDir, false);
if (!identity) throw new Error("no project identity");
const warm = await embedBatchForProject(identity, ["warm up the model"]);
if (!warm?.vectors[0]) throw new Error("model did not load");
say(`READY dims=${warm.vectors[0].length}`);

if (mode === "natural-exit") {
    flushLogger();
    let returnedAt = 0;
    process.on("exit", () => {
        say(`NATURAL_EXIT ms=${(performance.now() - returnedAt).toFixed(1)}`);
    });
    void bootstrap.unregisterPiProjectEmbeddings(db);
    returnedAt = performance.now();
} else {
    const paragraph =
        "Memory indexing compares recent conversation contents with the local project history. A worker owns the embedding model and returns one vector for each text. ";
    const texts = Array.from(
        { length: Number(countArg) },
        (_, index) => `${index} ${paragraph.repeat(40)}`,
    );
    const started = performance.now();
    const inflight = embedBatchForProject(identity, texts).then((result) => {
        say(
            `BATCH_DONE ms=${Math.round(performance.now() - started)} vectors=${result?.vectors.filter(Boolean).length ?? "null"}`,
        );
        return result;
    });
    await new Promise((resolve) => setTimeout(resolve, Number(delayArg)));

    if (mode === "measure") {
        await inflight;
        await shutdownEmbeddings(db);
        process.exit(0);
    } else if (mode === "pi-shutdown" || mode === "retire") {
        if (mode === "retire")
            registerProjectInObservationMode(
                db,
                identity,
                projectDir,
                { provider: "off" },
                "retire the live local worker",
            );
        const before = performance.now();
        await shutdownEmbeddings(db);
        say(`UNREGISTERED ms=${Math.round(performance.now() - before)}`);
        process.exit(0);
    } else if (mode === "exit") {
        process.exit(0);
    } else {
        throw new Error(`unknown mode ${mode}`);
    }
}
