export const PLAYBOOK = `# Batch playbook
Before acting, re-read PLAYBOOK.md with the shell tool. Do not claim a read is
confirmed by a summary alone. Work only in this throwaway project directory.
Use only shell commands for project work. Write source using heredocs, run builds
and tests after each change, read source back with cat or sed -n, then fix failures.
Keep modules small. Do not read opencode.json, credentials, or files outside this workspace.
`;

export function agents(revision: number): string {
    return `# Issue886 instruction revision ${revision}
This is a disposable CLI project. Read PLAYBOOK.md before acting. Use shell only.
Revision ${revision} adds a new requirement: print a labelled parser/evaluator/test
readback after each build. Keep earlier test coverage and inspect the source before edits.
${Array.from({ length: 12 }, (_, index) => `Rule ${revision}.${index}: test arithmetic boundary ${index} and preserve diagnostics for batch ${revision}.`).join("\n")}
`;
}

export function batchPrompt(batch: number, steps: number): string {
    return `Batch ${batch}: first re-read PLAYBOOK.md before acting.
Build and iteratively extend a small TypeScript arithmetic CLI in project/: tokenizer,
parser, evaluator, cli, fixtures, and tests. Use only the shell tool for project work:
heredocs to write files; cat and sed -n to read them; bun build and bun test after
every change; fix any failures before the next feature. Add precedence, parentheses,
unary operators, variables, diagnostics, JSON output, and regression tests one at a time.
Aim for at least ${steps} separate shell tool steps in this single turn, not one large
command. After each feature, inspect all source and test files and print detailed
fixture/test results. Re-read the playbook whenever you are unsure what was checked.
Keep going through this batch without waiting for approval. Do not use subagents.
Never inspect opencode.json or leave the workspace. When this batch is complete,
state the features and tests completed. Further batches will follow in this same session.`;
}
