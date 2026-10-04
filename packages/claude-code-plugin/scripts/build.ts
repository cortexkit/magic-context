/**
 * Build the plugin's runnable files into dist/.
 *
 * Claude Code installs a plugin by copying its directory, so the bundles must run
 * with nothing but Node.js present: no node_modules. Entries share code through
 * split chunks, as the OpenCode and Pi builds do (Bun's unsplit ESM output can
 * reference its async-module helper without defining it); dist/ is emptied first
 * so chunks from an earlier build never linger. `node:sqlite` is Node's own. Local embeddings
 * (Transformers.js, the ONNX runtimes, `sharp`) are not shipped: Transformers.js
 * resolves to a module that fails the lazy model load, so search stays lexical
 * unless an OpenAI-compatible embedding endpoint is configured.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");

const ENTRIES = [
    join(root, "src/mcp-server.ts"),
    join(root, "src/hook.ts"),
    // Run on every prompt and at the end of every turn; they import no database code.
    join(root, "src/prompt-hook.ts"),
    join(root, "src/stop-hook.ts"),
    // Loaded by the core's local-embedding client as a sibling of the bundle.
    join(root, "src/embedding-worker.ts"),
    // Schema migrations run on a worker thread when the module sits next to the bundle.
    join(root, "../plugin/src/features/magic-context/migration-worker.ts"),
];

rmSync(dist, { recursive: true, force: true });

const localEmbeddingsUnavailable = join(root, "src/local-embeddings-unavailable.ts");

const result = await Bun.build({
    entrypoints: ENTRIES,
    outdir: dist,
    target: "node",
    format: "esm",
    naming: { entry: "[name].[ext]", chunk: "chunk-[hash].[ext]" },
    splitting: true,
    external: ["onnxruntime-node", "onnxruntime-web", "sharp", "bun:sqlite", "node:sqlite"],
    plugins: [
        {
            name: "magic-context-claude-code-no-local-embeddings",
            setup(build) {
                build.onResolve({ filter: /^@huggingface\/transformers$/ }, () => ({
                    path: localEmbeddingsUnavailable,
                }));
            },
        },
    ],
});

if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
}
for (const output of result.outputs) {
    console.log(`${output.path.replace(`${root}/`, "")}  ${(output.size / 1024).toFixed(0)} KiB`);
}
