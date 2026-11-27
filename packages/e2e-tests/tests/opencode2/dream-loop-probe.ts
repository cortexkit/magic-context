import {
	existsSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
	appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../../plugin/src/features/magic-context/storage";
import { getDataDir } from "../../../plugin/src/shared/data-path";
import { createV2HiddenCompletionExecutor } from "../../../plugin/src/v2/hidden-completion";
import {
	HiddenChildHook,
	registerHiddenChildAgents,
} from "../../../plugin/src/v2/hooks/hidden-child";
import { nativeSessionRemove } from "../../../plugin/src/v2/hidden-child-native";
import {
	gaDatabasePath,
	V2StoreReader,
} from "../../../plugin/src/v2/store-reader";
import {
	insertMemory,
	getMemoryVerifications,
} from "../../../plugin/src/features/magic-context/memory";
import { acquireLease } from "../../../plugin/src/features/magic-context/dreamer/lease";
import { leaseKeyFor } from "../../../plugin/src/features/magic-context/dreamer/task-registry";
import { createDreamTaskExecutor } from "../../../plugin/src/features/magic-context/dreamer/task-executor";
import { getDreamRuns } from "../../../plugin/src/features/magic-context/dreamer/storage-dream-runs";
import {
	mapMemories,
	MAP_BATCH_FLOOR_MS,
} from "../../../plugin/src/features/magic-context/dreamer/map-memories";
import { runVerify } from "../../../plugin/src/features/magic-context/dreamer/verify";
import { recordMemoryVerifications } from "../../../plugin/src/features/magic-context/memory/storage-memory-verifications";
import {
	applyRetrospectiveLearnings,
	parseRetrospectiveLearnings,
} from "../../../plugin/src/features/magic-context/dreamer/retrospective-learnings";
import { writeJsonAtomically } from "../../src/write-json-atomically";

export default {
	id: "mc-dream-loop-probe",
	async setup(context: any) {
		const root = context.location.directory;
		const db = openDatabase();
		if (!db) throw new Error("No isolated storage");
		const hook = new HiddenChildHook();
		await registerHiddenChildAgents(context.agent);
		await context.tool.transform((editor: any) => {
			for (const name of ["ctx_memory", "ctx_search"])
				editor.add({
					name,
					description: `Fixture ${name}`,
					options: { codemode: false },
					input: {
						type: "object",
						properties: {
							value: { type: "string" },
							action: { type: "string" },
						},
						required: ["value"],
					},
					async execute(input: any) {
						appendFileSync(
							join(root, "tool-executed"),
							`${name}:${input.value}\n`,
						);
						return { content: `${name}-result:${input.value}` };
					},
				});
		});
		await context.tool.reload();
		await context.session.hook("context", async (draft: any) => {
			if (hook.owns(draft.sessionID))
				appendFileSync(
					join(root, "hook-steps.jsonl"),
					JSON.stringify({
						roles: draft.messages.map((m: any) => m.role),
						tools: Object.keys(draft.tools),
						messages: draft.messages,
					}) + "\n",
				);
			hook.apply(draft);
		});
		let ready: Promise<void> | undefined;
		const executor = await createV2HiddenCompletionExecutor(
			{
				...context.session,
				removeSession: nativeSessionRemove(context.session),
			},
			{
				db,
				projectIdentity: root,
                directory: root,
				hook,
				ensureAgent: () => (ready ??= context.agent.reload()),
				openReader: () =>
					new V2StoreReader(
						gaDatabasePath(
							getDataDir(),
							process.env.OPENCODE_CHANNEL ?? "latest",
						),
					),

			},
		);
		writeFileSync(join(root, "dream-loop-ready"), "ready");
		void (async () => {
			for (;;) {
				const file = join(root, "dream-loop-command.json");
				if (!existsSync(file)) {
					await Bun.sleep(20);
					continue;
				}
                let command: any;
                try { command = JSON.parse(readFileSync(file, "utf8")); }
                catch (error) {
                    if (!(error instanceof SyntaxError)) throw error;
                    // The writer can create the file before the JSON bytes reach the reader.
                    await Bun.sleep(20);
                    continue;
                }
				unlinkSync(file);
				let handle: any = null;
				let settled = false;
				try {
                    if (command.agent === "verify-step-runner") {
                        const ids = Array.from({ length: 20 }, (_, index) => {
                            const memory = insertMemory(db, { projectPath: root, category: "ARCHITECTURE", content: `Fixture claim ${index}.` });
                            recordMemoryVerifications(db, memory.id, ["fact.txt"], 1000);
                            return memory.id;
                        });
                        writeFileSync(join(root, "fact.txt"), "Fixture evidence");
                        const args = {
                            db, hiddenCompletionExecutor: executor, projectIdentity: root,
                            parentSessionId: command.parent, sessionDirectory: root,
                            holderId: "verify-step", leaseKey: "verify-step", forceBroad: true,
                            deadline: Date.now() + 300000, model: "openai/mock-model",
                            tokenBudget: 3000000, onProgress: () => { args.deadline = Date.now(); },
                        };
                        if (!acquireLease(db, args.holderId, args.leaseKey)) throw new Error("No verify lease");
                        const outcome = await runVerify(args);
                        const banked = ids.filter((id) => (getMemoryVerifications(db, ids).get(id)?.verifiedAt ?? 0) > 1000);
                        writeJsonAtomically(join(root, `dream-loop-result-${command.seq}.json`), { outcome, banked });
                        continue;
                    }
                    if (command.agent === "step-cap-runner") {
                        insertMemory(db, { projectPath: root, category: "ARCHITECTURE", content: "A fixture memory to curate." });
                        const execute = createDreamTaskExecutor({ sessionDirectory: root, parentSessionId: command.parent, hiddenCompletionExecutor: executor, openOpenCodeDb: () => null });
                        const result = await execute({ task: "curate", schedule: "0 4 * * 0", model: "openai/mock-model", timeoutMinutes: 5 }, { db, projectIdentity: root, holderId: "step-cap-proof", leaseKey: leaseKeyFor("curate", root) });
                        writeJsonAtomically(join(root, `dream-loop-result-${command.seq}.json`), { result, runs: getDreamRuns(db, root) });
                        continue;
                    }
					if (command.agent === "map-runner") {
						const memory = insertMemory(db, {
							projectPath: root,
							category: "ARCHITECTURE",
							content: "src/fixture.ts implements the fixture behavior",
						});
						const holderId = `holder-${command.seq}`;
						const leaseKey = `map-${command.seq}`;
						if (!acquireLease(db, holderId, leaseKey))
							throw new Error("Map lease unavailable");
						const outcome = await mapMemories({
							db,
							hiddenCompletionExecutor: executor,
							projectIdentity: root,
							parentSessionId: command.parent,
							sessionDirectory: root,
							holderId,
							leaseKey,
							deadline: Date.now() + MAP_BATCH_FLOOR_MS + 60000,
							model: "openai/mock-model",
						});
						writeJsonAtomically(
							join(root, `dream-loop-result-${command.seq}.json`),
							{
								ok: true,
								memoryID: memory.id,
								outcome,
								mapping: getMemoryVerifications(db, [memory.id]).get(memory.id),
							},
						);
						continue;
					}
					handle = await executor.open({
						parentSessionId: command.parent,
						agent: command.agent,
						kind: "dreamer-task",
						system: `DREAM_LOOP_${command.agent}`,
						model: "openai/mock-model",
						configuredModels: ["openai/mock-model"],
						timeoutMs: 12000,
						title: "dream",
						directory: root,
					});
					await executor.attempt(handle, {
						path: { id: handle.id },
						body: {
							model: { providerID: "openai", modelID: "mock-model" },
							parts: [{ type: "text", text: `DREAM_PROMPT_${command.agent}` }],
						},
					});
					const completion = await executor.collect(handle, 50);
					settled = true;
					const applied =
						command.agent === "dreamer-retrospective"
							? applyRetrospectiveLearnings({
									db,
									projectIdentity: root,
									sourceSessionId: command.parent,
									learnings: parseRetrospectiveLearnings(completion.text ?? ""),
									userMemoryCollectionEnabled: false,
								})
							: undefined;
					writeJsonAtomically(
						join(root, `dream-loop-result-${command.seq}.json`),
						{ ok: true, child: handle.id, completion, applied },
					);
				} catch (error) {
					writeJsonAtomically(
						join(root, `dream-loop-result-${command.seq}.json`),
						{
							ok: false,
							child: handle?.id,
							error: String(error),
						},
					);
				} finally {
					await executor.close(handle, {
						promptSettled: settled,
						privacySensitive: false,
						context: "probe",
						log() {},
					});
				}
			}
		})();
	},
};
