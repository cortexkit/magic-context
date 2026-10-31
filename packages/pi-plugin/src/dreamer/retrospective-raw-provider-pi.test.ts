/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
	RETROSPECTIVE_MAX_USER_MESSAGE_CHARS,
	readRetrospectiveScanWindow,
} from "@magic-context/core/features/magic-context/dreamer/retrospective-raw-provider";
import { advanceSessionActivity } from "@magic-context/core/features/magic-context/session-activity";
import { Database } from "@magic-context/core/shared/sqlite";
import { PiRetrospectiveRawProvider } from "./retrospective-raw-provider-pi";

describe("PiRetrospectiveRawProvider", () => {
	it("uses entry activity rather than file modified time when context.db is available", async () => {
		const db = new Database(":memory:");
		try {
			db.exec(
				"CREATE TABLE schema_migrations_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
			);
			advanceSessionActivity(db, "active", 300);
			advanceSessionActivity(db, "idle", 100);
			const provider = new PiRetrospectiveRawProvider({
				projectCwd: "/repo",
				contextDb: db,
				listSessions: () => [
					{
						id: "active",
						cwd: "/repo",
						path: "/sessions/a.jsonl",
						modified: 10,
					},
					{
						id: "idle",
						cwd: "/repo",
						path: "/sessions/i.jsonl",
						modified: 400,
					},
				],
			});
			expect(
				(await provider.listProjectSessions("project")).map(
					({ sessionId, updatedAt }) => ({ sessionId, updatedAt }),
				),
			).toEqual([
				{ sessionId: "idle", updatedAt: 100 },
				{ sessionId: "active", updatedAt: 300 },
			]);
		} finally {
			db.close();
		}
	});
	it("lists sessions for the resolved project cwd", async () => {
		const provider = new PiRetrospectiveRawProvider({
			projectCwd: "/repo/project",
			listSessions: () => [
				{
					id: "s1",
					cwd: "/repo/project",
					path: "/sessions/s1.jsonl",
					modified: 30,
				},
				{
					id: "s0",
					cwd: "/repo/project",
					path: "/sessions/s0.jsonl",
					modified: 20,
				},
				{
					id: "s2",
					cwd: "/repo/other",
					path: "/sessions/s2.jsonl",
					modified: 40,
				},
			],
			loadEntriesFromFile: () => [],
		});

		expect(await provider.listProjectSessions("identity")).toEqual([
			{ sessionId: "s0", path: "/sessions/s0.jsonl", updatedAt: 20 },
			{ sessionId: "s1", path: "/sessions/s1.jsonl", updatedAt: 30 },
		]);
	});
	// The retrospective reads this project's sessions by their recorded cwd. On
	// Windows one directory has several spellings (separators, drive-letter
	// case, a trailing separator); all are this project's, and a different
	// directory never is.
	it("lists sessions whose cwd is a Windows spelling of the project cwd, and no other directory", async () => {
		const provider = new PiRetrospectiveRawProvider({
			projectCwd: "D:\\coding\\siac\\wt\\app",
			listSessions: () => [
				{
					id: "forward",
					cwd: "D:/coding/siac/wt/app",
					path: "/s/f.jsonl",
					modified: 1,
				},
				{
					id: "lower",
					cwd: "d:\\coding\\siac\\wt\\app",
					path: "/s/l.jsonl",
					modified: 2,
				},
				{
					id: "trailing",
					cwd: "D:/coding/siac/wt/app/",
					path: "/s/t.jsonl",
					modified: 3,
				},
				{
					id: "sibling",
					cwd: "D:/coding/siac/wt/app-2",
					path: "/s/s.jsonl",
					modified: 4,
				},
				{
					id: "other",
					cwd: "D:/coding/siac/wt/other",
					path: "/s/o.jsonl",
					modified: 5,
				},
			],
			loadEntriesFromFile: () => [],
		});

		expect(
			(await provider.listProjectSessions("identity")).map(
				({ sessionId }) => sessionId,
			),
		).toEqual(["forward", "lower", "trailing"]);
	});

	it("reads only typed user messages newer than sinceMs", async () => {
		const provider = new PiRetrospectiveRawProvider({
			projectCwd: "/repo/project",
			listSessions: () => [
				{
					id: "s1",
					cwd: "/repo/project",
					path: "/sessions/s1.jsonl",
					modified: 30,
				},
			],
			loadEntriesFromFile: () => [
				{
					type: "message",
					message: { role: "user", timestamp: 100, content: "old" },
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						timestamp: 200,
						content: "tool output",
					},
				},
				{
					type: "custom_message",
					message: { role: "user", timestamp: 250, content: "nudge" },
				},
				{
					type: "message",
					message: {
						role: "user",
						timestamp: 300,
						content: [
							{ type: "text", text: "new line" },
							{ type: "image", data: "ignored" },
							{ type: "text", text: "second line" },
						],
					},
				},
			],
		});

		await provider.listProjectSessions("identity");
		expect(await provider.readUserMessagesSince("s1", 150, 10)).toEqual({
			messages: [
				{
					sessionId: "s1",
					ordinal: 4,
					role: "user",
					text: "new line\nsecond line",
					ts: 300,
				},
			],
			truncated: false,
		});
	});

	it("cleans reminder envelopes and synthetic parts before emitting user rows", async () => {
		const reminder =
			"<system-reminder>Prefrontal inbox notice</system-reminder>";
		const provider = new PiRetrospectiveRawProvider({
			projectCwd: "/repo/project",
			listSessions: () => [
				{ id: "s1", cwd: "/repo/project", path: "/sessions/s1.jsonl" },
			],
			loadEntriesFromFile: () => [
				{
					type: "message",
					message: { role: "user", timestamp: 100, content: reminder },
				},
				{
					type: "message",
					message: {
						role: "user",
						timestamp: 200,
						content: [
							{
								type: "text",
								text: "<system-reminder>AFT background bash finished</system-reminder>",
							},
							{ type: "text", text: "injected correction", synthetic: true },
						],
					},
				},
				{
					type: "message",
					message: {
						role: "user",
						timestamp: 300,
						content: [
							{ type: "text", text: reminder },
							{ type: "text", text: "Actually, keep the existing API." },
							{ type: "text", text: "synthetic follow-up", synthetic: true },
						],
					},
				},
				{
					type: "message",
					message: {
						role: "user",
						timestamp: 400,
						content: `Use the shared cleaner.\n${reminder}`,
					},
				},
			],
		});

		await provider.listProjectSessions("identity");
		const expected = [
			{
				sessionId: "s1",
				ordinal: 3,
				role: "user",
				text: "Actually, keep the existing API.",
				ts: 300,
			},
			{
				sessionId: "s1",
				ordinal: 4,
				role: "user",
				text: "Use the shared cleaner.",
				ts: 400,
			},
		];
		expect(await provider.readUserMessagesSince("s1", 0, 10)).toEqual({
			messages: expected,
			truncated: false,
		});
		expect(await provider.readUserMessagesBefore("s1", 500, 10)).toEqual(
			expected,
		);
		expect(await provider.readOldestMessageTimesSince(["s1"], 0)).toEqual(
			new Map([["s1", 300]]),
		);
	});

	it("marks a later user line only after an assistant has replied to a user turn", async () => {
		const provider = new PiRetrospectiveRawProvider({
			projectCwd: "/repo/project",
			listSessions: () => [
				{
					id: "s1",
					cwd: "/repo/project",
					path: "/sessions/s1.jsonl",
					modified: 30,
				},
			],
			loadEntriesFromFile: () => [
				{
					type: "message",
					message: { role: "assistant", timestamp: 50, content: "not a reply" },
				},
				{
					type: "message",
					message: { role: "user", timestamp: 100, content: "first request" },
				},
				{
					type: "message",
					message: {
						role: "assistant",
						timestamp: 150,
						content: "private response",
					},
				},
				{
					type: "message",
					message: {
						role: "user",
						timestamp: 200,
						content: "please correct that",
					},
				},
			],
		});

		await provider.listProjectSessions("identity");
		expect(
			(await provider.readUserMessagesSince("s1", 0, 10)).messages,
		).toEqual([
			{
				sessionId: "s1",
				ordinal: 2,
				role: "user",
				text: "first request",
				ts: 100,
			},
			{
				sessionId: "s1",
				ordinal: 4,
				role: "user",
				text: "please correct that",
				ts: 200,
				followsAssistantReply: true,
			},
		]);
	});

	it("inherits the shared clamp and oldest-first prompt budget for JSONL messages", async () => {
		const start = Date.now() - 1_000;
		const provider = new PiRetrospectiveRawProvider({
			projectCwd: "/repo/project",
			listSessions: () => [
				{
					id: "s1",
					cwd: "/repo/project",
					path: "/sessions/s1.jsonl",
					modified: start + 100,
				},
			],
			loadEntriesFromFile: () =>
				Array.from({ length: 6 }, (_, index) => ({
					type: "message",
					message: {
						role: "user",
						timestamp: start + index * 10,
						content: `pi-${index + 1} ${"oversized jsonl paste ".repeat(20_000)}`,
					},
				})),
		});

		const win = await readRetrospectiveScanWindow(provider, "identity", 0, 0, {
			usableInputTokens: 4_000,
		});

		expect(win.budgetTruncated).toBe(true);
		expect(win.messages.length).toBeGreaterThan(0);
		expect(win.messages.length).toBeLessThan(6);
		expect(win.messages[0]?.text).toStartWith("pi-1");
		expect(
			win.messages.every(
				(message) =>
					message.text.length <= RETROSPECTIVE_MAX_USER_MESSAGE_CHARS,
			),
		).toBe(true);
	});

	it("readUserMessagesBefore returns the newest N typed user lines at/before the cutoff", async () => {
		const provider = new PiRetrospectiveRawProvider({
			projectCwd: "/repo/project",
			listSessions: () => [
				{
					id: "s1",
					cwd: "/repo/project",
					path: "/sessions/s1.jsonl",
					modified: 30,
				},
			],
			loadEntriesFromFile: () => [
				{
					type: "message",
					message: { role: "user", timestamp: 100, content: "first" },
				},
				{
					type: "message",
					message: { role: "user", timestamp: 200, content: "second" },
				},
				{
					type: "message",
					message: { role: "user", timestamp: 300, content: "third" },
				},
				// after the cutoff — excluded
				{
					type: "message",
					message: { role: "user", timestamp: 400, content: "future" },
				},
			],
		});

		await provider.listProjectSessions("identity");
		// cutoff=300, count=2 → the 2 newest user lines AT/BEFORE 300, oldest→newest.
		const before = await provider.readUserMessagesBefore("s1", 300, 2);
		expect(before.map((m) => m.text)).toEqual(["second", "third"]);
		expect(before.every((m) => m.ts <= 300)).toBe(true);
	});
});
