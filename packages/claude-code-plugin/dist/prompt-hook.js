import"./chunk-6q6cxsv6.js";
import {
  resolveHookSession
} from "./chunk-zkqy4wkq.js";
import {
  readCaptureState
} from "./chunk-by49a6at.js";
import {
  driftOf,
  findOperations,
  renderSetup,
  renderOperation
} from "./chunk-q6aesfzf.js";

// src/prompt-hook.ts
import { readFileSync } from "node:fs";

// src/operation-skills/trigger.ts
var MAX_INJECTED = 2;
var TAG = "operation-skill";
function operationContextFor(projectDir, prompt) {
  if (prompt.trim().length === 0)
    return null;
  const matches = findOperations(projectDir, prompt, 5).filter((match) => match.strong).slice(0, MAX_INJECTED);
  if (matches.length === 0)
    return null;
  const sections = [
    "The request names a verified operation recorded for this project (Magic Context operation skill). If it asks for that operation, perform it with the setup and steps below: do not re-read the source or use another skill to work out the flow, and re-check only files flagged as changed since verification. If it asks to change the operation, these are its files, APIs and writes; once the change is verified, update the record with ctx_skill save."
  ];
  for (const { skill, operation } of matches) {
    const setup = renderSetup(skill);
    sections.push([
      `Skill "${skill.name}" (${skill.title}, scope ${skill.scope}, .claude/skills/${skill.name}/)`,
      ...setup ? ["Setup / 准备 (skip what is already running):", setup] : [],
      renderOperation(operation, driftOf(projectDir, operation))
    ].join(`
`));
  }
  const body = sections.join(`

`).replaceAll(`</${TAG}`, `<\\/${TAG}`);
  return `<${TAG}>
${body}
</${TAG}>`;
}

// src/prompt-hook.ts
try {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  const session = payload && typeof payload === "object" ? resolveHookSession(payload) : null;
  if (session && typeof payload.prompt === "string" && !readCaptureState(session.sessionId).disabled) {
    const context = operationContextFor(session.directory, payload.prompt);
    if (context) {
      process.stdout.write(`${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: context
        }
      })}
`);
    }
  }
} catch (error) {
  console.error(`[magic-context] prompt hook skipped: ${String(error)}`);
}
process.exit(0);
