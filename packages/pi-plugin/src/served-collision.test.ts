import { expect, test } from "bun:test";
import {
	adoptPiFallbackMessageTag,
	adoptPiFallbackToolOwnerTag,
} from "../../plugin/src/features/magic-context/storage-tags";
import {
	capturePiServedArray,
	clearPiServedArraySession,
	getPiServedTagNumbers,
} from "./served-array-ledger";
import { createTestDb } from "./test-utils.test";

for (const type of ["message", "tool"] as const) {
	test(`conflicting served ${type} numbers refuse adoption without changing either row`, () => {
		const db = createTestDb();
		try {
			for (const number of [1, 9]) {
				db.prepare(
					"INSERT INTO tags(message_id,type,status,session_id,tag_number,byte_size,tool_owner_message_id) VALUES (?,?,'active','conflicting',?,0,?)",
				).run(
					type === "message"
						? number === 1
							? "pi-msg-0-1-user:p0"
							: "real:p0"
						: "call",
					type,
					number,
					type === "tool"
						? number === 1
							? "pi-msg-0-1-assistant"
							: "real"
						: null,
				);
			}
			const before = db.prepare("SELECT * FROM tags ORDER BY tag_number").all();
			const evidence = new Set([1, 9]);
			expect(() =>
				type === "message"
					? adoptPiFallbackMessageTag(
							db,
							"conflicting",
							1,
							"pi-msg-0-1-user:p0",
							"real:p0",
							evidence,
						)
					: adoptPiFallbackToolOwnerTag(
							db,
							"conflicting",
							1,
							"call",
							"pi-msg-0-1-assistant",
							"real",
							evidence,
						),
			).toThrow("Conflicting served Pi");
			expect(
				db.prepare("SELECT * FROM tags ORDER BY tag_number").all(),
			).toEqual(before);
		} finally {
			db.close();
		}
	});
	for (const served of [1, 9]) {
		test(`served ${type} collision preserves ${served === 1 ? "fallback" : "real"} number regardless of allocation order`, () => {
			const db = createTestDb();
			const sessionId = `served-${type}-${served}`;
			try {
				for (const number of [9, 1]) {
					db.prepare(
						"INSERT INTO tags(message_id,type,status,session_id,tag_number,byte_size,tool_owner_message_id) VALUES (?,?, 'active',?,?,?,?)",
					).run(
						type === "message"
							? number === 1
								? "pi-msg-0-1-user:p0"
								: "real:p0"
							: "call",
						type,
						sessionId,
						number,
						number * 10,
						type === "tool"
							? number === 1
								? "pi-msg-0-1-assistant"
								: "real"
							: null,
					);
				}
				capturePiServedArray(sessionId, [`§${served}§ actually returned`], {
					servedTagNumbers: [served],
				});
				const evidence = getPiServedTagNumbers(sessionId);
				const result =
					type === "message"
						? adoptPiFallbackMessageTag(
								db,
								sessionId,
								1,
								"pi-msg-0-1-user:p0",
								"real:p0",
								evidence,
							)
						: adoptPiFallbackToolOwnerTag(
								db,
								sessionId,
								1,
								"call",
								"pi-msg-0-1-assistant",
								"real",
								evidence,
							);
				expect(result).toEqual({
					action: "folded",
					tagNumber: served,
					deletedTagNumbers: [served === 1 ? 9 : 1],
				});
				expect(
					db
						.prepare(
							"SELECT tag_number, message_id, tool_owner_message_id, byte_size FROM tags WHERE session_id = ?",
						)
						.all(sessionId),
				).toEqual([
					{
						tag_number: served,
						message_id: type === "message" ? "real:p0" : "call",
						tool_owner_message_id: type === "tool" ? "real" : null,
						byte_size: 90,
					},
				]);
			} finally {
				clearPiServedArraySession(sessionId);
				db.close();
			}
		});
	}
}
