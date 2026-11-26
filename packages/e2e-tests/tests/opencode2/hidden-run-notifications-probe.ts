import {
	appendFileSync,
	existsSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../../plugin/src/features/magic-context/storage";
import { getDataDir } from "../../../plugin/src/shared/data-path";
import { nativeSessionRemove } from "../../../plugin/src/v2/hidden-child-native";
import { createV2HiddenCompletionExecutor } from "../../../plugin/src/v2/hidden-completion";
import {
	HiddenChildHook,
	registerHiddenChildAgents,
} from "../../../plugin/src/v2/hooks/hidden-child";
import {
	gaDatabasePath,
	V2StoreReader,
} from "../../../plugin/src/v2/store-reader";

interface Command {
	seq: number;
	kind: "historian" | "maintenance";
	userID: string;
	race?: boolean;
}

// The real executor runs on the host's own session API. The file channel only controls when
// a run starts and records its result; session events and model calls come from the real host.
export default {
	id: "mc-hidden-run-notifications-probe",
	async setup(context: any) {
		const directory = context.location.directory as string;
		const file = (suffix: string) =>
			join(directory, `hidden-run-${process.pid}-${suffix}`);
		const db = openDatabase();
		if (!db) throw new Error("No isolated context database");
		const hook = new HiddenChildHook();
		await registerHiddenChildAgents(context.agent);
		await context.tool.transform((editor: any) => {
			editor.add({
				name: "ctx_memory",
				description: "Return fixture maintenance evidence",
				options: { codemode: false },
				input: { type: "object", properties: {}, additionalProperties: false },
				async execute() {
					return { content: "MAINTENANCE_TOOL_RESULT" };
				},
			});
		});
		await context.tool.reload();
		await context.session.hook("context", (draft: any) => {
			hook.apply(draft);
		});
		void (async () => {
			for await (const event of context.event.subscribe()) {
				const { type, data } = event;
				if (data?.sessionID)
					appendFileSync(
						file("events"),
						`${JSON.stringify({ type, id: data.sessionID, parent: data.parentID })}\n`,
					);
			}
		})();
		let agentsReady: Promise<void> | undefined;
		let race = false;
		const executor = await createV2HiddenCompletionExecutor(
			{
				...context.session,
				createHolder: async (input) => {
					if (race && input.id.endsWith("_2")) {
						writeFileSync(
							file("at-second-candidate"),
							JSON.stringify(input.id),
						);
						while (!existsSync(join(directory, "release-holder-race")))
							await Bun.sleep(20);
					}
					return context.session.create(input);
				},
				removeSession: nativeSessionRemove(context.session),
			},
			{
				db,
				directory,
				projectIdentity: directory,
				hook,
				hostVersion: context.app?.version,
				ensureAgent: () => (agentsReady ??= context.agent.reload()),
				openReader: () =>
					new V2StoreReader(
						gaDatabasePath(
							getDataDir(),
							process.env.OPENCODE_CHANNEL ?? "latest",
						),
					),
			},
		);
		writeFileSync(
			file("ready"),
			JSON.stringify({ version: context.app?.version }),
		);
		void (async () => {
			for (;;) {
				await Bun.sleep(20);
				if (!existsSync(file("command"))) continue;
				const command = JSON.parse(
					readFileSync(file("command"), "utf8"),
				) as Command;
				unlinkSync(file("command"));
				race = command.race === true;
				let handle: Awaited<ReturnType<typeof executor.open>> | null = null;
				let settled = false;
				let parentID: string | undefined;
				let result: object;
				try {
					const common = {
						parentSessionId: command.userID,
						system: `HIDDEN_NOTICE_${command.kind}_${command.seq}`,
						model: "openai/mock-model",
						timeoutMs: 20_000,
						title: "fixture",
						directory,
					};
					handle = await executor.open(
						command.kind === "historian"
							? { ...common, kind: "historian", agent: "historian" }
							: { ...common, kind: "dreamer-task", agent: "dreamer" },
					);
					const session = await context.session.get({ sessionID: handle.id });
					parentID = session.parentID;
					writeFileSync(
						file(`opened-${command.seq}`),
						JSON.stringify({ id: handle.id, parentID }),
					);
					await executor.attempt(handle, {
						path: { id: handle.id },
						body: {
							system: common.system,
							parts: [{ type: "text", text: `Hidden ${command.kind} fixture` }],
						},
					});
					const completion = await executor.collect(handle, 50);
					settled = true;
					result = { ok: true, text: completion.text };
				} catch (error) {
					result = { ok: false, error: String(error) };
				} finally {
					await executor.close(handle, {
						promptSettled: settled,
						privacySensitive: false,
						context: "fixture",
						log() {},
					});
				}
				const path = file(`result-${command.seq}`);
				writeFileSync(
					`${path}.tmp`,
					JSON.stringify({ ...result, id: handle?.id, parentID }),
				);
				renameSync(`${path}.tmp`, path);
			}
		})();
	},
};
