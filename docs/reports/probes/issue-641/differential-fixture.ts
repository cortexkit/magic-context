#!/usr/bin/env bun
// Run the same raw messages through each revision's real context handler.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerPiContextHandler, clearContextHandlerSession } from "../../../../packages/pi-plugin/src/context-handler";
import { resetLkgSlotsForTest } from "../../../../packages/plugin/src/hooks/magic-context/lkg-slot";
import { createFakePi, createTestDb, fakeContext, userMessage, assistantMessage, assistantToolCall, toolResultMessage, type PiMessage } from "../../../../packages/pi-plugin/src/test-utils.test";

const root = process.env.MC641_DIFF_ROOT;
const cwd = process.env.MC641_DIFF_CWD;
if (!root || !cwd || !root.includes("/magic-context/issue-641/")) throw new Error("disposable differential root required");
mkdirSync(root, { recursive: true });
const db = createTestDb(join(root, "context.db"));
const pi = createFakePi();
registerPiContextHandler(pi.pi as never, { db });
const handler = pi.handlers.get("context") as unknown as (event: {messages: PiMessage[]}, ctx: ReturnType<typeof fakeContext>) => Promise<{messages: PiMessage[]}>;
const raw: PiMessage[] = [userMessage("Inspect the shared writer budget", 1), assistantToolCall("call", "Read", {path:"example.ts"}, 2), toolResultMessage("call", "export const budget = 21000;", 3), assistantMessage("The budget includes preparation.", 4)];
const outputs: PiMessage[][] = [];
try {
  for (let turn = 0; turn < 3; turn++) {
    raw.push(userMessage(`Follow-up ${turn}: explain admission and replay`, 5 + turn));
    const input = structuredClone(raw);
    const ids = input.map((_, index) => `entry-${index}`);
    const result = await handler({messages: input}, fakeContext("diff", cwd, ids, input));
    outputs.push(result.messages);
  }
  const lsof = execFileSync("/usr/sbin/lsof", ["-p", String(process.pid)], {encoding:"utf8", windowsHide:true});
  const dbLines = lsof.split("\n").filter(line => /\.db(?:[- ]|$)/.test(line));
  if (!dbLines.length || dbLines.some(line => !line.includes(root))) throw new Error("differential DB isolation failed");
  writeFileSync(join(root,"lsof.txt"), lsof);
  writeFileSync(join(root,"output.json"), JSON.stringify(outputs));
  writeFileSync(join(root,"rows.json"), JSON.stringify({
    tags: db.prepare("SELECT message_id,type,status,tag_number,session_id FROM tags ORDER BY tag_number").all(),
    sources: db.prepare("SELECT tag_id,content FROM source_contents ORDER BY tag_id").all(),
  }));
  console.log(JSON.stringify({root, turns:outputs.length, messages:outputs.map(messages=>messages.length), dbDescriptors:dbLines.length}));
} finally {
  clearContextHandlerSession("diff");
  resetLkgSlotsForTest();
  db.close();
}
