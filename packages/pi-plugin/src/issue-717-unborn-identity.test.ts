import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import {
	__resetProjectIdentityForTests,
	__setProjectIdentityTestHooks,
} from "@magic-context/core/features/magic-context/memory/project-identity";
import { getMemoryById } from "@magic-context/core/features/magic-context/memory/storage-memory";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { isolatedTestGitEnv } from "@magic-context/core/shared/test-git-env";
import {
	cleanupTestTempDir,
	createTestTempDirFromPath,
} from "@magic-context/core/shared/test-temp-dir";
import { createTestDb } from "./test-utils.test";
import { registerMagicContextTools } from "./tools/index";

const tempDirs: string[] = [];
const savedPath = process.env.PATH;

afterEach(() => {
	process.env.PATH = savedPath;
	__resetProjectIdentityForTests();
	for (const dir of tempDirs) cleanupTestTempDir(dir);
	tempDirs.length = 0;
});

function makeTempDir(prefix: string): string {
	const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

type Execute = (...args: unknown[]) => Promise<{
	isError?: boolean;
	content: Array<{ text?: string }>;
}>;

// Pi resolves project identity through the host's TypeScript resolver. A Pi session
// started right after `git init` must get the directory identity even when every git
// call runs into the identity probe's timeout, as a stalled git call can on Windows. The
// test fakes the slow git with a shell script, which Windows cannot run as `git`, so it
// is skipped there.
test.skipIf(process.platform === "win32")(
	"Pi ctx_memory in a fresh git repository keys memories by directory with a slow git",
	async () => {
		const directory = makeTempDir("pi-unborn-repo-");
		const gitConfig = join(makeTempDir("pi-unborn-gitconfig-"), "config");
		writeFileSync(gitConfig, "");
		execFileSync("git", ["init", "-q"], {
			cwd: directory,
			env: isolatedTestGitEnv({ GIT_CONFIG_GLOBAL: gitConfig }),
			windowsHide: true,
		});
		const bin = makeTempDir("pi-slow-git-");
		writeFileSync(join(bin, "git"), "#!/bin/sh\nexec sleep 10\n");
		chmodSync(join(bin, "git"), 0o755);
		process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
		__setProjectIdentityTestHooks({ gitTimeoutMs: 300 });

		const db = createTestDb();
		try {
			const tools = new Map<string, { execute: Execute }>();
			registerMagicContextTools(
				{
					registerTool: (tool: { name: string; execute: Execute }) =>
						tools.set(tool.name, tool),
					registerCommand: () => undefined,
				} as never,
				{ db },
			);
			const result = await tools
				.get("ctx_memory")
				?.execute(
					"call-unborn",
					{ action: "write", category: "ARCHITECTURE", content: "Fresh repo." },
					new AbortController().signal,
					undefined,
					{
						cwd: directory,
						sessionManager: { getSessionId: () => "ses-pi-unborn" },
					},
				);
			expect(result?.isError).toBeUndefined();
			const id = Number(result?.content[0]?.text?.match(/ID:\s*(\d+)/)?.[1]);
			const hash = createHash("md5")
				.update(path.resolve(directory), "utf8")
				.digest("hex")
				.slice(0, 12);
			expect(getMemoryById(db, id)?.projectPath).toBe(`dir:${hash}`);
		} finally {
			closeQuietly(db);
		}
	},
);
