/**
 * Golden generators run plugin code outside any host and outside the test
 * preload, so without this their log lines land in the running host's
 * diagnostic log. There they mix with real sessions and can trigger a rotation
 * that discards the live log's history. The logger reads this variable on
 * every flush, so setting it from a side-effect import is enough.
 */
import { tmpdir } from "node:os";
import path from "node:path";

if (!process.env.MAGIC_CONTEXT_LOG_PATH?.trim()) {
    process.env.MAGIC_CONTEXT_LOG_PATH = path.join(tmpdir(), "magic-context-golden-generators.log");
}
