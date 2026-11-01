import { expect, test } from "bun:test";
import { readReplayEnvelope } from "@magic-context/core/features/magic-context/storage-replay-document";
import {
	responsesModel,
	signedHistory,
} from "./__tests__/responses-signed-history";
import { applyNativeResponseTagReplayPi } from "./native-replay-tags-pi";
import {
	piPreparedStructure,
	piPreparedStructureMismatch,
} from "./pi-dispatch-structure";
import { createTestDb } from "./test-utils.test";

test("defer replay retains frozen native bytes after an allowed unsigned text rewrite", () => {
	const db = createTestDb();
	const sessionId = "signed-to-unsigned-replay";
	const prepared = () => {
		const message = signedHistory();
		message.content[0].text = "§2§ Hello";
		return [message];
	};
	try {
		const rebuilding = prepared();
		expect(
			applyNativeResponseTagReplayPi({
				db,
				sessionId,
				messages: rebuilding,
				canApply: true,
			}),
		).toBe(1);
		const served = rebuilding[0].providerPayload.items;
		expect(served[0].content[0].text).toBe("Hello");
		expect(
			piPreparedStructureMismatch(
				{ input: served },
				piPreparedStructure(rebuilding, responsesModel, "omp"),
			),
		).toBeUndefined();
		const ledger = readReplayEnvelope(db, sessionId);

		const deferred = prepared();
		// Oh My Pi removes text signatures when its assistant-message hook rewrites
		// text. The request comparison below accepts the resulting unsigned form.
		deferred[0].content[0].text = "Hello";
		Reflect.deleteProperty(deferred[0].content[0], "textSignature");
		expect(
			applyNativeResponseTagReplayPi({
				db,
				sessionId,
				messages: deferred,
				canApply: false,
			}),
		).toBe(0);
		expect(readReplayEnvelope(db, sessionId)).toEqual(ledger);
		const replayed = deferred[0].providerPayload.items;
		expect(
			piPreparedStructureMismatch(
				{ input: replayed },
				piPreparedStructure(deferred, responsesModel, "omp"),
			),
		).toBeUndefined();
		// Replay the previously served result after its text signature is removed;
		// this pass must not discover or apply a new strip.
		expect(replayed).toEqual(served);
	} finally {
		db.close();
	}
});
