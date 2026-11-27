#!/usr/bin/env bun

import { filesForMode, validateModeManifest } from "./validate-mode-manifest";
import { selectRustShard } from "./mode-selection";

export { selectRustShard } from "./mode-selection";

if (import.meta.main) {
    try {
        const spec = process.argv[2];
        if (!spec || process.argv.length !== 3) throw new Error("usage: select-rust-shard.ts i/n");
        for (const path of selectRustShard(filesForMode(validateModeManifest(), "rust"), spec)) {
            console.log(path);
        }
    } catch (error) {
        console.error(String(error));
        process.exit(1);
    }
}
