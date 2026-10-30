import type { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

export const OMP_RETAINED_NO_TOOLS_ENV = "MAGIC_CONTEXT_OMP_RETAINED_NO_TOOLS";

type Frame = Record<string, unknown>;
const FRAME_LIMIT = 1024 * 1024;
const MESSAGE_LIMIT = 64 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;

/** Runtime negotiation and bounded OMP v2 framing, independent of the package version. */
export class OmpRetainedRpc {
	private phase:
		| "ready"
		| "negotiating"
		| "inventory"
		| "supported"
		| "failed" = "ready";
	private readonly negotiateId = `mc-negotiate-${randomUUID()}`;
	private readonly inventoryId = `mc-tools-${randomUUID()}`;
	private pending?: {
		id: string;
		count: number;
		length: number;
		next: number;
		bytes: number;
		chunks: Buffer[];
	};
	private activeId?: string;
	private completedId?: string;
	private waitingForSettlement?: string;
	private frameLimit = FRAME_LIMIT;
	private messageLimit = MESSAGE_LIMIT;
	readonly tools: string[] = [];

	constructor(
		private readonly callbacks: {
			write(line: string): void;
			ready(): void;
			unavailable(reason: string): void;
			terminal(): void;
		},
	) {}

	get supported(): boolean {
		return this.phase === "supported";
	}
	get promptComplete(): boolean {
		return this.activeId !== undefined && this.completedId === this.activeId;
	}

	private fail(reason: string): void {
		if (this.phase === "failed") return;
		this.phase = "failed";
		this.callbacks.unavailable(reason);
	}

	private write(frame: Frame): void {
		const json = JSON.stringify(frame);
		const bytes = Buffer.from(json, "utf8");
		if (bytes.length > this.messageLimit)
			throw new Error("OMP RPC message exceeds negotiated limit");
		if (bytes.length + 1 <= this.frameLimit) {
			this.callbacks.write(`${json}\n`);
			return;
		}
		const chunkBytes = Math.min(
			CHUNK_BYTES,
			Math.floor((this.frameLimit - 256) * 0.7),
		);
		const count = Math.ceil(bytes.length / chunkBytes);
		const chunkId = randomUUID();
		for (let index = 0; index < count; index++)
			this.callbacks.write(
				`${JSON.stringify({
					type: "rpc_chunk",
					chunkId,
					index,
					count,
					byteLength: bytes.length,
					data: bytes
						.subarray(index * chunkBytes, (index + 1) * chunkBytes)
						.toString("base64"),
				})}\n`,
			);
	}

	prompt(message: string, id: string): void {
		if (!this.supported) throw new Error("OMP retained RPC is not negotiated");
		this.activeId = id;
		this.completedId = undefined;
		this.waitingForSettlement = undefined;
		this.write({ type: "prompt", message, id });
	}

	private decode(value: Frame): Frame | undefined {
		if (value.type !== "rpc_chunk") {
			if (this.pending) throw new Error("interrupted RPC chunks");
			return value;
		}
		const { chunkId, index, count, byteLength, data } = value;
		if (
			typeof chunkId !== "string" ||
			!chunkId ||
			chunkId.length > 128 ||
			typeof index !== "number" ||
			!Number.isSafeInteger(index) ||
			index < 0 ||
			typeof count !== "number" ||
			!Number.isSafeInteger(count) ||
			count < 2 ||
			count > 1024 ||
			index >= count ||
			typeof byteLength !== "number" ||
			!Number.isSafeInteger(byteLength) ||
			byteLength < 1 ||
			byteLength > this.messageLimit ||
			typeof data !== "string" ||
			!data ||
			data.length > this.frameLimit ||
			!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
				data,
			)
		)
			throw new Error("invalid RPC chunk");
		const bytes = Buffer.from(data, "base64");
		if (bytes.toString("base64") !== data || bytes.length > this.frameLimit)
			throw new Error("invalid RPC chunk data");
		if (!this.pending) {
			if (index !== 0) throw new Error("RPC chunks must start at zero");
			this.pending = {
				id: chunkId,
				count,
				length: byteLength,
				next: 0,
				bytes: 0,
				chunks: [],
			};
		}
		const pending = this.pending;
		if (
			pending.id !== chunkId ||
			pending.count !== count ||
			pending.length !== byteLength ||
			pending.next !== index
		)
			throw new Error("RPC chunk sequence mismatch");
		pending.bytes += bytes.length;
		if (pending.bytes > pending.length)
			throw new Error("RPC chunk length exceeded");
		pending.chunks.push(bytes);
		pending.next++;
		if (pending.next < pending.count) return undefined;
		if (pending.bytes !== pending.length)
			throw new Error("RPC chunk length mismatch");
		this.pending = undefined;
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(
				Buffer.concat(pending.chunks),
			),
		);
	}

	/** Consume every parsed JSONL frame; only a correlated v2 terminal can complete a prompt. */
	accept(line: string): Frame | undefined {
		if (this.phase === "failed") return undefined;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			return undefined;
		}
		try {
			if (
				Buffer.byteLength(line, "utf8") > this.frameLimit ||
				!value ||
				typeof value !== "object" ||
				Array.isArray(value)
			)
				throw new Error("invalid RPC frame");
			const frame = this.decode(value as Frame);
			if (!frame) return undefined;
			if (frame.type === "ready" && this.phase === "ready") {
				if (
					!Array.isArray(frame.supportedProtocolVersions) ||
					!frame.supportedProtocolVersions.includes(2) ||
					typeof frame.maxFrameBytes !== "number" ||
					!Number.isSafeInteger(frame.maxFrameBytes) ||
					frame.maxFrameBytes < 1024 ||
					typeof frame.maxReassembledFrameBytes !== "number" ||
					!Number.isSafeInteger(frame.maxReassembledFrameBytes) ||
					frame.maxReassembledFrameBytes < frame.maxFrameBytes
				)
					throw new Error("OMP RPC v2 is not advertised");
				this.frameLimit = Math.min(FRAME_LIMIT, frame.maxFrameBytes);
				this.messageLimit = Math.min(
					MESSAGE_LIMIT,
					frame.maxReassembledFrameBytes,
				);
				this.phase = "negotiating";
				this.write({
					id: this.negotiateId,
					type: "negotiate_protocol",
					protocolVersion: 2,
				});
			} else if (
				frame.type === "response" &&
				frame.id === this.negotiateId &&
				this.phase === "negotiating"
			) {
				const data = frame.data as Frame | undefined;
				if (
					frame.command !== "negotiate_protocol" ||
					frame.success !== true ||
					data?.protocolVersion !== 2
				)
					throw new Error("OMP RPC v2 negotiation refused");
				this.phase = "inventory";
				this.write({ id: this.inventoryId, type: "get_state" });
			} else if (
				frame.type === "response" &&
				frame.id === this.inventoryId &&
				this.phase === "inventory"
			) {
				const data = frame.data as Frame | undefined;
				if (
					frame.command !== "get_state" ||
					frame.success !== true ||
					!Array.isArray(data?.dumpTools) ||
					data.dumpTools.length !== 0
				)
					throw new Error(
						"OMP historian tool inventory is not empty or observable",
					);
				this.phase = "supported";
				this.callbacks.ready();
			} else if (frame.type === "prompt_result" && frame.id === this.activeId) {
				if (frame.status !== "completed" || frame.agentInvoked !== true)
					throw new Error("OMP prompt did not complete an agent turn");
				if (typeof frame.sessionSettled !== "boolean")
					throw new Error("OMP prompt settlement is unobservable");
				if (frame.sessionSettled) {
					this.completedId = this.activeId;
					this.callbacks.terminal();
				} else this.waitingForSettlement = this.activeId;
			} else if (
				frame.type === "session_settled" &&
				this.waitingForSettlement !== undefined &&
				this.waitingForSettlement === this.activeId
			) {
				this.completedId = this.activeId;
				this.waitingForSettlement = undefined;
				this.callbacks.terminal();
			}
			return frame;
		} catch (error) {
			this.fail(
				error instanceof Error ? error.message : "OMP RPC frame failed",
			);
			return undefined;
		}
	}
}

/** An idle process probe never sends a provider prompt or relies on a version string. */
export async function probeOmpRetainedRpc(input: {
	spawn: typeof spawn;
	command: string;
	args: string[];
	cwd?: string;
	env: NodeJS.ProcessEnv;
	timeoutMs?: number;
}): Promise<boolean> {
	return new Promise((resolve) => {
		let result: boolean | undefined;
		let finished = false;
		const child = input.spawn(input.command, input.args, {
			cwd: input.cwd,
			env: input.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const lines = createInterface({ input: child.stdout! });
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const done = (value: boolean) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			lines.close();
			resolve(value);
		};
		const stop = (value: boolean) => {
			if (result !== undefined || finished) return;
			result = value;
			child.kill("SIGTERM");
			if (finished) return;
			killTimer = setTimeout(() => {
				child.kill("SIGKILL");
				done(value);
			}, 500);
		};
		const timer = setTimeout(() => stop(false), input.timeoutMs ?? 5000);
		const protocol = new OmpRetainedRpc({
			write: (line) => {
				child.stdin!.write(line);
			},
			ready: () => stop(true),
			unavailable: () => stop(false),
			terminal: () => {},
		});
		child.stderr?.resume();
		child.stdin?.on("error", () => stop(false));
		child.once("error", () => done(false));
		child.once("exit", () => done(result ?? false));
		lines.on("line", (line) => {
			protocol.accept(line);
		});
	});
}
