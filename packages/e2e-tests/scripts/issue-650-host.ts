import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	collectMessageEntryIdsByRef,
	registerPiContextHandler,
} from "../../pi-plugin/src/context-handler";
import { appendCompartments } from "../../plugin/src/features/magic-context/compartment-storage";
import { runMigrations } from "../../plugin/src/features/magic-context/migrations";
import { initializeDatabase } from "../../plugin/src/features/magic-context/storage-db";
import { updateSessionMeta } from "../../plugin/src/features/magic-context/storage-meta";
import { setHarness } from "../../plugin/src/shared/harness";
import { Database } from "../../plugin/src/shared/sqlite";

// issue-650-probe.ts launches this host bundle in Node with HOME, XDG directories
// and both database overrides under one fresh root, keeping real sessions untouched.
const root = process.env.HOME!;
const messageMode = process.env.ISSUE_650_MESSAGE === "1";
const host = await import(pathToFileURL(process.env.ISSUE_650_HOST!).href);
const agentDir = join(root, ".pi/agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "anthropic-messages",
				baseUrl: process.env.ISSUE_650_MOCK,
				apiKey: "mock-key",
				models: [
					{
						id: "mock",
						name: "Mock",
						reasoning: false,
						input: ["text"],
						contextWindow: messageMode ? 240000 : 200000,
						maxTokens: messageMode ? 36000 : 4096,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	}),
);
setHarness("pi");
const db = new Database(
	join(process.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"),
);
initializeDatabase(db);
runMigrations(db);
let perturb = false;
const snapshots: unknown[] = [];
const resolutions: unknown[] = [];
let bootstrapFrame = messageMode;
let frameTimestamp = 0;
const extension = (pi: any) => {
	if (messageMode)
		pi.on("context", (event: any, ctx: any) => {
			if (bootstrapFrame)
				return {
					messages: [
						{
							role: "user",
							content: "system position framing",
							timestamp: frameTimestamp,
						},
						...event.messages,
					],
				};
			const entries = ctx.sessionManager.getBranch();
			const ids = collectMessageEntryIdsByRef(
				ctx,
				event.messages,
				ctx.sessionManager.getSessionId(),
				entries,
			);
			resolutions.push({
				input: structuredClone(event.messages),
				ids,
				branch: entries,
			});
		});
	pi.on("context", (event: any) => {
		if (!perturb) return;
		// A legal context-only extension edit: insert framing and rewrite the
		// assistant's prose, but leave the actual call and its timestamp intact.
		const messages = structuredClone(event.messages);
		const assistant = messages.find(
			(m: any) =>
				m.role === "assistant" &&
				m.content.some((p: any) => p.type === "toolCall"),
		);
		if (assistant)
			assistant.content.unshift({ type: "text", text: "context-only framing" });
		messages.unshift(
			{ role: "user", content: "temporary framing", timestamp: 1 },
			{ role: "user", content: "more framing", timestamp: 2 },
		);
		return { messages };
	});
	registerPiContextHandler(pi, {
		db,
		protectedTags: 0,
		...(messageMode
			? {
					injection: {
						injectionBudgetTokens: 10000,
						memoryEnabled: false,
						injectDocs: false,
					},
					scheduler: { executeThresholdPercentage: 80 },
				}
			: {}),
	});
	pi.on("context", (event: any) => {
		snapshots.push(structuredClone(event.messages));
	});
};
const codemode = process.env.ISSUE_650_CODEMODE === "1";
const loader = new host.DefaultResourceLoader({
	cwd: root,
	agentDir,
	extensionFactories: [
		...(codemode ? [host.createCodemodeExtension({ mode: "on" })] : []),
		extension,
	],
});
await loader.reload();
const settingsManager = host.SettingsManager.create(root, agentDir);
settingsManager.applyOverrides({
	defaultProvider: "mock",
	defaultModel: "mock",
	compaction: { enabled: false },
	...(codemode ? { defaultTools: ["+codemode"] } : {}),
});
const manager = host.SessionManager.create(root, join(root, "sessions"));
const source = "ordinary user source ".padEnd(221, "x");
let oldId: string | undefined;
let keptId: string | undefined;
if (messageMode) {
	const user = {
		role: "user",
		content: [{ type: "text", text: source }],
		timestamp: 1700000000000,
	};
	oldId = manager.appendMessage(structuredClone(user));
	keptId = manager.appendMessage(structuredClone(user));
}
const { session } = await host.createAgentSession({
	cwd: root,
	agentDir,
	resourceLoader: loader,
	settingsManager,
	sessionManager: manager,
});
await session.bindExtensions({});
console.log("READY", process.pid);
await new Promise<void>((resolve) =>
	process.stdin.once("data", () => resolve()),
);
process.stdin.pause();
try {
	if (messageMode) {
		if (!oldId || !keptId) throw new Error("message fixture lacks entry ids");
		const bootstrap = "bootstrap prior history ".repeat(500);
		appendCompartments(db, manager.getSessionId(), [
			{
				sequence: 0,
				startMessage: 1,
				endMessage: 1,
				startMessageId: oldId,
				endMessageId: oldId,
				title: "initial prior history",
				content: bootstrap,
				p1: bootstrap,
				p2: bootstrap,
				p3: bootstrap,
				p4: bootstrap,
			},
		]);
		await session.prompt("initial real identities");
		const initial = db
			.prepare("SELECT * FROM tags WHERE message_id = ?")
			.all(`${keptId}:p0`);
		updateSessionMeta(db, manager.getSessionId(), {
			lastInputTokens: 178473,
			lastContextPercentage: 87.5,
			lastResponseTime: Date.now(),
		});
		const history = "substantive prior history ".repeat(1500);
		appendCompartments(db, manager.getSessionId(), [
			{
				sequence: 1,
				startMessage: 1,
				endMessage: 1,
				startMessageId: oldId,
				endMessageId: oldId,
				title: "prior retained history",
				content: history,
				p1: history,
				p2: history,
				p3: history,
				p4: history,
			},
		]);
		bootstrapFrame = false;
		adaptPiAppendCompaction(manager.appendCompaction.bind(manager))(
			"managed history",
			keptId,
			178473,
			{ source: "magic-context" },
			true,
		);
		session.agent.state.messages = manager.buildSessionContext().messages;
		await session.prompt("retained projection only");
		const after = db
			.prepare("SELECT * FROM tags WHERE entry_fingerprint = ?")
			.all((initial[0] as any)?.entry_fingerprint);
		bootstrapFrame = true;
		frameTimestamp = 1;
		await session.prompt("canonical entry alignment returns");
		const final = db
			.prepare("SELECT * FROM tags WHERE entry_fingerprint = ?")
			.all((initial[0] as any)?.entry_fingerprint);
		writeFileSync(
			join(root, "message-result.json"),
			JSON.stringify(
				{
					initial,
					after,
					final,
					oldId,
					keptId,
					resolutions,
					snapshots,
					entries: manager.getBranch(),
				},
				null,
				2,
			),
		);
		console.log(
			JSON.stringify({
				initial,
				after,
				unresolved: (resolutions[0] as any)?.ids?.filter(
					(id: any) => id === undefined,
				).length,
			}),
		);
		if (
			initial.length !== 1 ||
			after.some((row: any) => row.message_id.startsWith("pi-msg-"))
		)
			throw new Error("issue 650: retained message acquired a fallback tag");
		const number = (initial[0] as any).tag_number;
		const bodies = (snapshots as any[][]).map((messages) =>
			messages.find(
				(message) =>
					message.role === "user" &&
					message.timestamp === 1700000000000 &&
					message.content.some(
						(part: any) => part.text === `§${number}§ ${source}`,
					),
			),
		);
		if (
			bodies.length !== 3 ||
			bodies.some(
				(body) => !body || JSON.stringify(body) !== JSON.stringify(bodies[0]),
			)
		)
			throw new Error("retained user bytes changed or third turn was refused");
		console.log("PASS: retained message keeps its real tag after compaction");
	} else {
		await session.prompt("make one tool call");
		const initial = db.prepare("SELECT * FROM tags WHERE type = 'tool'").all();
		perturb = true;
		await session.prompt("continue with temporary framing");
		const perturbed = db
			.prepare("SELECT * FROM tags WHERE type = 'tool'")
			.all();
		perturb = false;
		await session.prompt("continue normally");
		const final = db.prepare("SELECT * FROM tags WHERE type = 'tool'").all();
		writeFileSync(
			join(root, "result.json"),
			JSON.stringify(
				{ initial, perturbed, final, snapshots, entries: manager.getBranch() },
				null,
				2,
			),
		);
		console.log(JSON.stringify({ initial, perturbed, final }));
		if (initial.length !== 1 || perturbed.length !== 1 || final.length !== 1)
			throw new Error("issue 650: tool call acquired a second tag");
		if ((initial[0] as any).tag_number !== (final[0] as any).tag_number)
			throw new Error("issue 650: served number changed");
		const results = (snapshots as any[][]).flatMap((messages) =>
			messages.filter(
				(m) => m.role === "toolResult" && m.toolCallId === "call650",
			),
		);
		if (
			!results.length ||
			results.some((m) => JSON.stringify(m) !== JSON.stringify(results[0]))
		)
			throw new Error("issue 650: already-served tool bytes changed");
		if (results[0].isError) throw new Error("mock tool call did not succeed");
		console.log(
			"PASS: 3 turns, one tool identity, identical tool-result bytes",
		);
	}
	console.log("AUDIT_COMPLETE");
	await new Promise<void>((resolve) => {
		process.stdin.once("data", () => resolve());
		process.stdin.resume();
	});
	process.stdin.destroy();
} finally {
	session.dispose();
	db.close();
}
