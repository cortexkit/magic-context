#!/usr/bin/env node
import { runSetup } from "./setup";

const command = process.argv[2];

if (command === "setup") {
    runSetup().then((code) => process.exit(code));
} else {
    console.log("");
    console.log("  Magic Context CLI");
    console.log("  ─────────────────");
    console.log("");
    console.log("  Commands:");
    console.log("    setup    Interactive setup wizard");
    console.log("");
    console.log("  Usage:");
    console.log("    bunx @cortexkit/opencode-magic-context setup");
    console.log("    npx @cortexkit/opencode-magic-context setup");
    console.log("");
    process.exit(command ? 1 : 0);
}
