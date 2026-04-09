#!/usr/bin/env node
import { runDoctor } from "./doctor";
import { runSetup } from "./setup";

const command = process.argv[2];

if (command === "setup") {
    runSetup().then((code) => process.exit(code));
} else if (command === "doctor") {
    const force = process.argv.includes("--force");
    runDoctor({ force }).then((code) => process.exit(code));
} else {
    console.log("");
    console.log("  Magic Context CLI");
    console.log("  ─────────────────");
    console.log("");
    console.log("  Commands:");
    console.log("    setup            Interactive setup wizard (first-time install)");
    console.log("    doctor           Check and fix configuration issues");
    console.log("    doctor --force   Force clear plugin cache (fixes broken dependencies)");
    console.log("");
    console.log("  Usage:");
    console.log("    bunx @cortexkit/opencode-magic-context@latest setup");
    console.log("    bunx @cortexkit/opencode-magic-context@latest doctor");
    console.log("");
    process.exit(command ? 1 : 0);
}
