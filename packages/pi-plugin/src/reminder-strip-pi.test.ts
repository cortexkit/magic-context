import { afterEach, expect, spyOn, test } from "bun:test";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import {
	encodePiContentDecision,
	freezePiContentDecision,
	getPiContentDecisions,
} from "@magic-context/core/features/magic-context/pi-content-decisions";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { getTagsBySession } from "@magic-context/core/features/magic-context/storage-tags";
import { Database } from "@magic-context/core/shared/sqlite";
import { replayPiReminderStrips } from "./reminder-strip-pi";

const databases: Database[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function setup(content: string, source = content) {
	const db = new Database(":memory:");
	databases.push(db);
	initializeDatabase(db);
	runMigrations(db);
	db.prepare(
		"INSERT INTO tags(session_id, message_id, tag_number, type, status, byte_size) VALUES('session','m:p0',1,'message','active',100)",
	).run();
	db.prepare(
		"INSERT INTO source_contents(session_id,tag_id,content,created_at) VALUES('session',1,?,1)",
	).run(source);
	const activeTags = getTagsBySession(db, "session");
	let served = content;
	const args = {
		db,
		sessionId: "session",
		activeTags,
		targets: new Map([
			[
				1,
				{
					getContent: () => served,
					setContent: (value: string) => {
						served = value;
					},
				},
			],
		]),
		legacyReminderTagNumbers: new Set<number>(),
		cacheBusting: false,
	};
	return { args, served: () => served };
}

test("ordinary defer reminder replay does not read source bodies or freeze decisions", () => {
	const { args, served } = setup("ordinary user instruction");
	const prepare = spyOn(args.db, "prepare");
	try {
		replayPiReminderStrips(args);
		expect(
			prepare.mock.calls.filter(([sql]) =>
				sql.includes("FROM source_contents"),
			),
		).toHaveLength(0);
		expect(served()).toBe("ordinary user instruction");
		expect(getPiContentDecisions(args.db, "session").size).toBe(0);
	} finally {
		prepare.mockRestore();
	}
});

test("legacy stripped defer projections preserve exact bytes without freezing", () => {
	const { args, served } = setup(
		"§1§ words <SYSTEM-REMINDER>noise</SYSTEM-REMINDER>",
		"words",
	);
	replayPiReminderStrips(args);
	expect(served()).toBe("§1§ words");
	expect(getPiContentDecisions(args.db, "session").size).toBe(0);
});

test("a bust still freezes temporal-only legacy sources with no removable projection", () => {
	const { args, served } = setup("ordinary user instruction", "<!-- +5m -->");
	replayPiReminderStrips({ ...args, cacheBusting: true });
	expect(served()).toBe("ordinary user instruction");
	expect(
		getPiContentDecisions(args.db, "session").has(
			encodePiContentDecision("reminder-strip", "m:p0"),
		),
	).toBe(true);
});

test("frozen reminders replay byte-identically without querying sources", () => {
	const { args, served } = setup(
		"§1§ words <system-reminder>noise</system-reminder>",
	);
	expect(
		freezePiContentDecision(args.db, "session", "reminder-strip", "m:p0"),
	).toBe(true);
	const prepare = spyOn(args.db, "prepare");
	try {
		replayPiReminderStrips(args);
		expect(served()).toBe("§1§ words");
		expect(
			prepare.mock.calls.filter(([sql]) =>
				sql.includes("FROM source_contents"),
			),
		).toHaveLength(0);
	} finally {
		prepare.mockRestore();
	}
});

test("a bust records no new decision for a tag the caller protects, but keeps serving legacy bytes", () => {
	const { args, served } = setup(
		"§1§ words <SYSTEM-REMINDER>noise</SYSTEM-REMINDER>",
		"words",
	);
	replayPiReminderStrips({
		...args,
		cacheBusting: true,
		legacyReminderTagNumbers: new Set([1]),
		mayRecordDecision: () => false,
	});
	expect(served()).toBe("§1§ words");
	expect(getPiContentDecisions(args.db, "session").size).toBe(0);
	replayPiReminderStrips({
		...args,
		cacheBusting: true,
		legacyReminderTagNumbers: new Set([1]),
		mayRecordDecision: () => true,
	});
	expect(
		getPiContentDecisions(args.db, "session").has(
			encodePiContentDecision("reminder-strip", "m:p0"),
		),
	).toBe(true);
});
