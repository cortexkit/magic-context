import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	assistantToolCall,
	toolResultMessage,
	userMessage,
} from "../test-utils.test";

export const LARGE_SESSION_ID = "synthetic-large-session";

const ownerId = (n: number) =>
	n % 1000 === 0 ? `pi-msg-${n}-assistant` : `owner-${n}`;

/** Deterministic tool-heavy history; no content or identities come from a real session. */
export function seedLargeSession(db: ContextDatabase, count: number): void {
	const insert = db.prepare(`INSERT INTO tags (
		session_id, tag_number, message_id, type, status, byte_size,
		tool_owner_message_id, tool_name, input_byte_size, token_count,
		input_token_count, drop_mode, harness, entry_fingerprint
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pi', ?)`);
	db.transaction(() => {
		for (let n = 1; n <= count; n++) {
			const tool = n % 5 !== 1;
			const status =
				n <= Math.floor(count * 0.965)
					? "dropped"
					: n <= Math.floor(count * 0.99)
						? "compacted"
						: "active";
			insert.run(
				LARGE_SESSION_ID,
				n,
				tool ? `call-${n}` : `entry-${n}:p0`,
				tool ? "tool" : "message",
				status,
				tool ? 4096 : 96,
				tool ? ownerId(n) : null,
				tool ? "Read" : null,
				tool ? 64 : 0,
				tool ? 1024 : 24,
				tool ? 16 : null,
				status === "dropped" ? "full" : null,
				JSON.stringify([
					null,
					1_750_000_000_000 + n,
					tool ? "assistant" : "user",
					null,
					n.toString(16).padStart(16, "0").repeat(4),
				]),
			);
		}
		db.prepare(`INSERT INTO session_meta(session_id, counter, harness)
			VALUES (?, ?, 'pi') ON CONFLICT(session_id) DO UPDATE SET counter=excluded.counter`).run(
			LARGE_SESSION_ID,
			count,
		);
		const compartment = db.prepare(`INSERT INTO compartments
			(session_id, sequence, start_message, end_message, title, content, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`);
		for (const [index, range] of compactedRanges(count).entries()) {
			compartment.run(
				LARGE_SESSION_ID,
				index + 1,
				((range.first - 1) / 5) * 9,
				(range.last / 5) * 9 - 1,
				`Synthetic fold ${index + 1}`,
				`Summary of synthetic tags ${range.first} through ${range.last}.`,
				1_750_000_000_000 + range.last,
			);
		}
	}).immediate();
}

/** Fold full 500-tag blocks up to 99% of the synthetic tags; leave the remainder outside the ranges. */
export function compactedRanges(
	count: number,
): { first: number; last: number }[] {
	return Array.from({ length: Math.floor((count * 0.99) / 500) }, (_, i) => ({
		first: i * 500 + 1,
		last: (i + 1) * 500,
	}));
}

export function largeSessionMessages(first: number, last: number) {
	const messages: unknown[] = [];
	const ids: string[] = [];
	for (let n = first; n <= last; n++) {
		if (n % 5 === 1) {
			messages.push(
				userMessage(`Inspect synthetic file ${n}.`, 1_750_000_000_000 + n),
			);
			ids.push(`entry-${n}`);
		} else {
			messages.push(
				assistantToolCall(
					`call-${n}`,
					"Read",
					{ path: `src/file-${n}.ts` },
					1_750_000_000_000 + n,
				),
			);
			ids.push(ownerId(n));
			messages.push(
				toolResultMessage(
					`call-${n}`,
					`Synthetic result for file ${n}: ${"code line\n".repeat(16)}`,
					1_750_000_000_001 + n,
				),
			);
			ids.push(`result-${n}`);
		}
	}
	return { messages, ids };
}
