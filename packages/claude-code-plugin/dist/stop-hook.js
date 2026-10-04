import"./chunk-6q6cxsv6.js";
import"./chunk-zkqy4wkq.js";
import {
  handleStop
} from "./chunk-by49a6at.js";

// src/stop-hook.ts
import { readFileSync } from "node:fs";
try {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  const instruction = payload && typeof payload === "object" ? handleStop(payload) : null;
  if (instruction) {
    process.stdout.write(`${JSON.stringify({
      decision: "block",
      reason: instruction,
      systemMessage: "Magic Context: saving verified work with the session's own model (not an error) · 正在用当前模型沉淀已验证的工作，不是错误"
    })}
`);
  }
} catch (error) {
  console.error(`[magic-context] stop hook skipped: ${String(error)}`);
}
process.exit(0);
