import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

// Isolate each fresh/append pair: process-global caches from unrelated sessions
// must not inflate the next sample's heap or change its first-pass work.
const packageRoot = resolve(import.meta.dir, "..");
const scratch = resolve(packageRoot, "../../target/scratch");
mkdirSync(scratch, { recursive: true });
const root = mkdtempSync(join(scratch, "pi-preparation-runner-"));
const output = resolve(
	process.env.MC_PI_PROFILE_OUTPUT ?? join(scratch, "pi-preparation.json"),
);
const runs = Number(process.env.MC_PI_PROFILE_RUNS ?? 5);
if (!Number.isSafeInteger(runs) || runs < 1)
	throw new Error("Invalid run count");
const records: Array<Record<string, unknown>> = [];
let runtime: unknown;
try {
	for (const host of (process.env.MC_PI_PROFILE_HOSTS ?? "pi,omp").split(",")) {
		for (const count of (
			process.env.MC_PI_PROFILE_COUNTS ?? "5000,20000,50000"
		).split(",")) {
			for (let run = 0; run < runs; run++) {
				const home = join(root, `${host}-${count}-${run}`);
				mkdirSync(home, { recursive: true });
				const homes = Object.fromEntries(
					[
						"HOME",
						"XDG_CONFIG_HOME",
						"XDG_DATA_HOME",
						"XDG_CACHE_HOME",
						"XDG_STATE_HOME",
						"XDG_RUNTIME_DIR",
						"PI_CODING_AGENT_DIR",
						"MAGIC_CONTEXT_STORAGE_DIR",
					].map((key) => [key, join(home, key)]),
				);
				for (const directory of Object.values(homes))
					mkdirSync(directory, { recursive: true });
				const path = join(home, "sample.json");
				const child = Bun.spawn(
					[
						process.execPath,
						"test",
						"src/__tests__/issue-910-preparation-profile.test.ts",
					],
					{
						cwd: packageRoot,
						env: {
							...process.env,
							...homes,
							MC_PI_PREPARATION_PROFILE: "1",
							MC_PI_PROFILE_COUNTS: count,
							MC_PI_PROFILE_HOSTS: host,
							MC_PI_PROFILE_RUNS: "1",
							MC_PI_PROFILE_OUTPUT: path,
						},
						stdin: "ignore",
						stdout: "inherit",
						stderr: "inherit",
					},
				);
				const code = await child.exited;
				if (code !== 0)
					throw new Error(
						`Profile failed: host=${host} count=${count} run=${run} exit=${code}`,
					);
				const sample = JSON.parse(readFileSync(path, "utf8"));
				runtime = sample.runtime;
				records.push(
					...sample.records.map((row: Record<string, unknown>) => ({
						...row,
						run,
					})),
				);
				writeFileSync(
					output,
					`${JSON.stringify({ runtime, records }, null, 2)}\n`,
				);
			}
		}
	}
	console.log(
		`Profile complete: ${records.length} passes in ${records.length / 2} isolated processes; output=${output}`,
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}
