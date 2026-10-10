import { expect, test } from "bun:test";
import {
	guardSqliteTransformPass,
	withSqliteTransformPass,
} from "@magic-context/core/shared/sqlite";
import { PiContextBudget, PiContextDeadlineError } from "./pi-context-budget";
import { createTestDb } from "./test-utils.test";

test("one monotonic budget charges preparation before writer admission and reserves recovery", () => {
	let now = 0;
	const budget = new PiContextBudget(0, () => now);
	expect(budget.writerAllowance()).toBe(16500);
	now = 5000;
	expect(budget.writerAllowance()).toBe(14000);
	now = 21000;
	expect(() => budget.assert()).toThrow(PiContextDeadlineError);
	expect(() => budget.assertOutcome()).not.toThrow();
	now = 25000;
	expect(() => budget.assertOutcome()).toThrow(PiContextDeadlineError);
});

test("elapsed time fences a commit after an event-loop stall without a timer firing", () => {
	const db = createTestDb();
	let now = 0;
	const budget = new PiContextBudget(0, () => now);
	try {
		expect(() =>
			withSqliteTransformPass(() => {
				guardSqliteTransformPass({
					assert: budget.assert,
					remainingMs: () => budget.remainingWork(),
				});
				db.transaction(() => {
					db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run(
						"stalled",
					);
					now = 32000;
				})();
			}),
		).toThrow(PiContextDeadlineError);
		expect(
			db.prepare("SELECT * FROM session_meta WHERE session_id='stalled'").get(),
		).toBeNull();
	} finally {
		db.close();
	}
});

test("only a completed managed result survives ownership change for decision attribution", () => {
	let now = 0;
	const budget = new PiContextBudget(0, () => now);
	budget.assertOwner = () => {
		throw new Error("superseded");
	};
	expect(() => budget.assertDecisionPublication()).toThrow("superseded");
	budget.completed = true;
	expect(() => budget.assertDecisionPublication()).not.toThrow();
	now = 25000;
	expect(() => budget.assertDecisionPublication()).toThrow(
		PiContextDeadlineError,
	);
	now = 0;
	budget.abandoned = true;
	expect(() => budget.assertDecisionPublication()).toThrow(
		PiContextDeadlineError,
	);
});

test("mandatory publication consumes the completion reserve but cannot outlive the outcome deadline", () => {
	const db = createTestDb();
	let now = 22000;
	const budget = new PiContextBudget(0, () => now);
	try {
		expect(() => budget.assert()).toThrow(PiContextDeadlineError);
		withSqliteTransformPass(() => {
			guardSqliteTransformPass({
				assert: budget.assertOutcome,
				remainingMs: () => 25000 - now,
			});
			db.prepare(
				"INSERT INTO session_meta (session_id) VALUES ('completed')",
			).run();
			now = 25000;
			expect(() =>
				db
					.prepare("INSERT INTO session_meta (session_id) VALUES ('late')")
					.run(),
			).toThrow(PiContextDeadlineError);
		});
		expect(db.prepare("SELECT session_id FROM session_meta").all()).toEqual([
			{ session_id: "completed" },
		]);
	} finally {
		db.close();
	}
});
