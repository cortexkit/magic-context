import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/** Embed the pinned runtime's bytes at build time, never from a live host path. */
export function embeddedQuickJsWasmBase64(): string {
    const require = createRequire(import.meta.url);
    return readFileSync(require.resolve("@jitl/quickjs-wasmfile-release-asyncify/wasm")).toString(
        "base64",
    );
}
