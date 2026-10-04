// src/operation-skills/store.ts
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
var OPERATION_SKILL_SCHEMA = "magic-context/operation-skill@1";
var TRIGGER_KINDS = [
  "button",
  "form",
  "link",
  "menu",
  "event",
  "route",
  "shortcut",
  "schedule",
  "api",
  "cli",
  "other"
];

class OperationSkillError extends Error {
}
var NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
var DESCRIPTION_LIMIT = 1024;
function isValidSkillName(name) {
  return NAME_PATTERN.test(name);
}
function skillsRoot(projectDir) {
  return join(projectDir, ".claude", "skills");
}
function skillDir(projectDir, name) {
  if (!isValidSkillName(name)) {
    throw new OperationSkillError(`invalid skill name "${name}": use lowercase letters, digits and hyphens (max 64)`);
  }
  return join(skillsRoot(projectDir), name);
}
function writeAtomic(path, content) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}
function readManaged(directory) {
  try {
    const parsed = JSON.parse(readFileSync(join(directory, "flow.json"), "utf8"));
    return parsed?.schema === OPERATION_SKILL_SCHEMA && Array.isArray(parsed.operations) ? parsed : null;
  } catch {
    return null;
  }
}
function loadSkill(projectDir, name) {
  return readManaged(skillDir(projectDir, name));
}
function listSkills(projectDir) {
  let entries;
  try {
    entries = readdirSync(skillsRoot(projectDir));
  } catch {
    return [];
  }
  return entries.filter(isValidSkillName).map((entry) => readManaged(join(skillsRoot(projectDir), entry))).filter((skill) => skill !== null).sort((a, b) => a.name.localeCompare(b.name));
}
function pathOf(reference, projectDir) {
  if (!reference)
    return null;
  const candidate = reference.trim().replace(/[:#](L?\d+(-\d+)?|[A-Za-z_$][\w$.]*)$/, "").replace(/^\.\//, "");
  if (!candidate || /\s/.test(candidate) || !/[./]/.test(candidate))
    return null;
  if (/^[a-z]+:\/\//i.test(candidate))
    return null;
  const absolute = resolve(projectDir, candidate);
  const inside = relative(projectDir, absolute);
  if (!inside || inside.startsWith("..") || isAbsolute(inside))
    return null;
  return normalize(inside);
}
function referencedFiles(operation, projectDir) {
  const references = [
    operation.trigger.location,
    operation.action.location,
    ...operation.apis.map((api) => api.handler),
    ...operation.state.map((update) => update.location),
    ...operation.filesToModify
  ];
  const files = new Set;
  for (const reference of references) {
    const path = pathOf(reference, projectDir);
    if (path)
      files.add(path);
  }
  return [...files].sort();
}
function hashFile(projectDir, path) {
  try {
    return createHash("sha256").update(readFileSync(join(projectDir, path))).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}
function driftOf(projectDir, operation) {
  const changed = [];
  const missing = [];
  for (const [path, recorded] of Object.entries(operation.fileHashes)) {
    const current = hashFile(projectDir, path);
    if (current === recorded)
      continue;
    if (current === null)
      missing.push(path);
    else
      changed.push(path);
  }
  return { changed, missing };
}
function isStale(drift) {
  return drift.changed.length > 0 || drift.missing.length > 0;
}
function cleanList(values) {
  return (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
}
function toOperation(input, projectDir, now) {
  if (!isValidSkillName(input.id)) {
    throw new OperationSkillError(`invalid operation id "${input.id}": use lowercase letters, digits and hyphens`);
  }
  if (cleanList(input.steps).length === 0) {
    throw new OperationSkillError(`operation "${input.id}" needs at least one step`);
  }
  if (!input.verification.method.trim()) {
    throw new OperationSkillError(`operation "${input.id}" must say how it was verified (verification.method)`);
  }
  const fileHashes = {};
  for (const path of referencedFiles(input, projectDir)) {
    fileHashes[path] = hashFile(projectDir, path);
  }
  return {
    id: input.id,
    trigger: input.trigger,
    intents: cleanList(input.intents),
    action: input.action,
    apis: input.apis ?? [],
    writes: input.writes ?? [],
    state: input.state ?? [],
    ...input.saveAndLinkage?.trim() ? { saveAndLinkage: input.saveAndLinkage.trim() } : {},
    filesToModify: cleanList(input.filesToModify),
    steps: cleanList(input.steps),
    verification: { ...input.verification, verifiedAt: now },
    fileHashes
  };
}
function persist(projectDir, skill) {
  const directory = skillDir(projectDir, skill.name);
  mkdirSync(directory, { recursive: true });
  writeAtomic(join(directory, "flow.json"), `${JSON.stringify(skill, null, 2)}
`);
  writeAtomic(join(directory, "SKILL.md"), renderSkillMarkdown(skill));
  return directory;
}
function saveSkill(projectDir, input, now = new Date().toISOString()) {
  const directory = skillDir(projectDir, input.name);
  const existing = readManaged(directory);
  if (!existing && existsSync(directory)) {
    throw new OperationSkillError(`.claude/skills/${input.name} exists and is not a Magic Context operation skill; choose another name`);
  }
  const title = input.title?.trim() || existing?.title;
  const description = input.description?.trim() || existing?.description;
  if (!title || !description) {
    throw new OperationSkillError("a new skill needs a title and a description");
  }
  if (description.length > DESCRIPTION_LIMIT - 200) {
    throw new OperationSkillError(`description is too long (${description.length} chars); keep it under ${DESCRIPTION_LIMIT - 200}`);
  }
  const operations = [...existing?.operations ?? []];
  for (const operationInput of input.operations ?? []) {
    const operation = toOperation(operationInput, projectDir, now);
    const index = operations.findIndex((candidate) => candidate.id === operation.id);
    if (index >= 0)
      operations[index] = operation;
    else
      operations.push(operation);
  }
  if (operations.length === 0) {
    throw new OperationSkillError("a skill needs at least one operation");
  }
  const setup = input.setup ? cleanList(input.setup) : existing?.setup ?? [];
  const skill = {
    schema: OPERATION_SKILL_SCHEMA,
    name: input.name,
    title,
    description,
    scope: normalizeScope(input.scope ?? existing?.scope ?? "."),
    ...setup.length > 0 ? { setup } : {},
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    operations
  };
  return { skill, created: existing === null, path: persist(projectDir, skill) };
}
function normalizeScope(scope) {
  const trimmed = scope.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : ".";
}
function markVerified(projectDir, name, operationId, verification, now = new Date().toISOString()) {
  const skill = loadSkill(projectDir, name);
  if (!skill)
    throw new OperationSkillError(`no operation skill named "${name}"`);
  const operation = skill.operations.find((candidate) => candidate.id === operationId);
  if (!operation) {
    throw new OperationSkillError(`skill "${name}" has no operation "${operationId}"`);
  }
  const refreshed = toOperation({ ...operation, verification }, projectDir, now);
  skill.operations = skill.operations.map((candidate) => candidate.id === operationId ? refreshed : candidate);
  skill.updatedAt = now;
  persist(projectDir, skill);
  return skill;
}
function removeSkillOrOperation(projectDir, name, operationId) {
  const skill = loadSkill(projectDir, name);
  if (!skill)
    throw new OperationSkillError(`no operation skill named "${name}"`);
  if (operationId === undefined) {
    rmSync(skillDir(projectDir, name), { recursive: true, force: true });
    return "skill";
  }
  const remaining = skill.operations.filter((candidate) => candidate.id !== operationId);
  if (remaining.length === skill.operations.length) {
    throw new OperationSkillError(`skill "${name}" has no operation "${operationId}"`);
  }
  if (remaining.length === 0) {
    rmSync(skillDir(projectDir, name), { recursive: true, force: true });
    return "skill";
  }
  skill.operations = remaining;
  skill.updatedAt = new Date().toISOString();
  persist(projectDir, skill);
  return "operation";
}
function searchTokens(text) {
  const tokens = new Set;
  const lower = text.toLowerCase();
  for (const word of lower.match(/[a-z0-9_]{2,}/g) ?? [])
    tokens.add(word);
  for (const run of lower.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? []) {
    if (run.length === 1)
      tokens.add(run);
    for (let index = 0;index + 1 < run.length; index++)
      tokens.add(run.slice(index, index + 2));
  }
  return tokens;
}
function overlap(query, text) {
  if (!text)
    return 0;
  let count = 0;
  for (const token of searchTokens(text))
    if (query.has(token))
      count++;
  return count;
}
function findOperations(projectDir, query, limit = 3) {
  const queryTokens = searchTokens(query);
  const lowerQuery = query.toLowerCase();
  const matches = [];
  for (const skill of listSkills(projectDir)) {
    for (const operation of skill.operations) {
      let score = 5 * overlap(queryTokens, operation.trigger.label) + 4 * operation.intents.reduce((sum, intent) => sum + overlap(queryTokens, intent), 0) + 2 * overlap(queryTokens, `${skill.title} ${skill.name} ${operation.id}`) + 2 * overlap(queryTokens, operation.action.summary) + 2 * operation.apis.reduce((sum, api) => sum + overlap(queryTokens, api.endpoint), 0) + operation.writes.reduce((sum, write) => sum + overlap(queryTokens, write.target), 0) + overlap(queryTokens, skill.scope);
      const label = operation.trigger.label.toLowerCase();
      const labelHit = label.length > 0 && lowerQuery.includes(label);
      const intentHit = operation.intents.some((intent) => lowerQuery.includes(intent.toLowerCase()));
      if (labelHit)
        score += 10;
      if (intentHit)
        score += 10;
      if (score > 0) {
        matches.push({ skill, operation, score, strong: labelHit || intentHit });
      }
    }
  }
  return matches.sort((a, b) => b.score - a.score).slice(0, limit);
}
function describeTrigger(trigger) {
  const parts = [`${trigger.kind} "${trigger.label}"`];
  if (trigger.event)
    parts.push(`(${trigger.event})`);
  if (trigger.location)
    parts.push(`at \`${trigger.location}\``);
  if (trigger.selector)
    parts.push(`selector \`${trigger.selector}\``);
  return parts.join(" ");
}
function describeApi(api) {
  const head = `\`${api.method ? `${api.method.toUpperCase()} ` : ""}${api.endpoint}\``;
  const details = [
    api.request ? `request: ${api.request}` : "",
    api.response ? `response: ${api.response}` : "",
    api.handler ? `handled by \`${api.handler}\`` : ""
  ].filter(Boolean);
  return details.length > 0 ? `${head}: ${details.join("; ")}` : head;
}
function renderSetup(skill) {
  const setup = skill.setup ?? [];
  return setup.map((step, index) => `${index + 1}. ${step}`).join(`
`);
}
function renderOperation(operation, drift) {
  const lines = [
    `### ${operation.trigger.label} (\`${operation.id}\`)`,
    "",
    `- **触发 Trigger:** ${describeTrigger(operation.trigger)}`
  ];
  if (operation.intents.length > 0) {
    lines.push(`- **意图 Intents:** ${operation.intents.map((intent) => `"${intent}"`).join(", ")}`);
  }
  const handler = [
    operation.action.handler ? `\`${operation.action.handler}\`` : "",
    operation.action.location ? `in \`${operation.action.location}\`` : ""
  ].filter(Boolean).join(" ");
  lines.push(`- **Action:** ${operation.action.summary}${handler ? ` (${handler})` : ""}`);
  const list = (title, items) => {
    if (items.length === 0)
      return;
    lines.push(`- **${title}:**`);
    for (const item of items)
      lines.push(`  - ${item}`);
  };
  list("接口 APIs", operation.apis.map(describeApi));
  list("写入数据 Writes", operation.writes.map((write) => `${write.target}${write.fields ? `: ${write.fields}` : ""}${write.detail ? ` (${write.detail})` : ""}`));
  list("更新状态 State", operation.state.map((update) => `${update.target}: ${update.change}${update.location ? ` (\`${update.location}\`)` : ""}`));
  if (operation.saveAndLinkage) {
    lines.push(`- **保存与联动 Save & linkage:** ${operation.saveAndLinkage}`);
  }
  list("需修改的文件 Files to modify", operation.filesToModify.map((file) => `\`${file}\``));
  lines.push("- **执行步骤 Steps:**");
  operation.steps.forEach((step, index) => {
    lines.push(`  ${index + 1}. ${step}`);
  });
  const { verification } = operation;
  lines.push(`- **已验证 Verified:** ${verification.verifiedAt.slice(0, 10)} by ${verification.method}${verification.evidence ? ` (evidence: ${verification.evidence})` : ""}`);
  if (drift && isStale(drift)) {
    const changed = [...drift.changed, ...drift.missing.map((path) => `${path} (missing)`)];
    lines.push(`- **⚠ Changed since verification:** ${changed.map((path) => `\`${path}\``).join(", ")}. Re-check these files before relying on this operation, then ctx_skill verify.`);
  }
  return lines.join(`
`);
}
function renderSkillMarkdown(skill) {
  const labels = skill.operations.map((operation) => operation.trigger.label).join(", ");
  let description = `${skill.description} Operations: ${labels}. Verified flows: perform them from this skill instead of re-reading the code.`;
  if (description.length > DESCRIPTION_LIMIT) {
    description = `${description.slice(0, DESCRIPTION_LIMIT - 1)}…`;
  }
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    "<!-- Managed by Magic Context. Change it with the ctx_skill tool (action save); flow.json is the source. -->",
    "",
    `# ${skill.title}`,
    "",
    `Scope / 目录: \`${skill.scope}\` (relative to the project root).`,
    "",
    "Verified operations of this part of the project. When the user asks for one of them (by button, event or intent), follow its action and steps directly instead of analysing the code again. Each operation lists the files it depends on; `ctx_skill read` reports which of them changed since the operation was verified, and only those need re-checking.",
    "",
    ...skill.setup?.length ? [
      "## 准备 Setup",
      "",
      "Before running an operation, get the project ready (skip what is already running):",
      "",
      renderSetup(skill),
      ""
    ] : [],
    "## 操作 Operations",
    "",
    skill.operations.map((operation) => renderOperation(operation)).join(`

`),
    ""
  ].join(`
`);
}

export { TRIGGER_KINDS, OperationSkillError, loadSkill, listSkills, driftOf, isStale, saveSkill, markVerified, removeSkillOrOperation, findOperations, renderSetup, renderOperation };
