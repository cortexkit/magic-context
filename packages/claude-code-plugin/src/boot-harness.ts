/**
 * Pin the harness before any other Magic Context module is evaluated: storage
 * rows are attributed to it. Import this first from every entry point.
 */
import { setHarness } from "@magic-context/core/shared/harness";

setHarness("claude-code");
