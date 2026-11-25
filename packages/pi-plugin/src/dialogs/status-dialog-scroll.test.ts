import { describe, expect, it, mock, spyOn } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage-meta";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestDb, fakeContext } from "../test-utils.test";
import {
	type StatusDialogDeps,
	showStatusDialog,
	stopStatusDialogRefresh,
} from "./status-dialog";

interface Dialog {
	render(width: number): string[];
	handleInput(data: string): void;
	dispose(): void;
}

const keys = {
	up: "\x1b[A",
	down: "\x1b[B",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
	home: "\x1b[H",
	end: "\x1b[F",
};

async function withDialog(
	run: (
		dialog: Dialog,
		host: {
			terminal: { rows: number };
			deps: StatusDialogDeps;
			refresh: () => void;
			requestRender: ReturnType<typeof mock>;
			done: ReturnType<typeof mock>;
			clearTimer: ReturnType<typeof spyOn>;
		},
	) => void,
	shortSessionTtl = false,
	useRowsHost = false,
) {
	const db = createTestDb();
	const sessionId = "ses-status-scroll";
	if (shortSessionTtl) {
		// A short session TTL lets the real model select two columns at wide widths.
		getOrCreateSessionMeta(db, sessionId);
		updateSessionMeta(db, sessionId, { cacheTtl: "10m" });
	}
	const terminal = { rows: 24 };
	const deps: StatusDialogDeps = {
		db,
		projectIdentity: resolveProjectIdentity(process.cwd()),
	};
	const requestRender = mock(() => {});
	const done = mock(() => {});
	let tick = () => {};
	const timer = spyOn(globalThis, "setInterval").mockImplementation(((
		callback: () => void,
	) => {
		tick = callback;
		return 123;
	}) as never);
	const clearTimer = spyOn(globalThis, "clearInterval").mockImplementation(
		() => {},
	);
	try {
		await showStatusDialog(
			{ getAllTools: () => [] } as never,
			{
				...fakeContext(sessionId),
				getContextUsage: () => ({
					tokens: 40_000,
					percent: 20,
					contextWindow: 200_000,
				}),
				getSystemPrompt: () => "system prompt",
				ui: {
					async custom(factory: (...args: unknown[]) => Dialog) {
						const dialog = factory(
							useRowsHost
								? { size: () => terminal, requestRender }
								: { terminal, requestRender },
							{
								fg: (_color: string, text: string) => text,
								bold: (text: string) => text,
							},
							{},
							done,
						);
						try {
							run(dialog, {
								terminal,
								deps,
								refresh: () => tick(),
								requestRender,
								done,
								clearTimer,
							});
						} finally {
							dialog.dispose();
						}
					},
				},
			} as never,
			deps,
		);
	} finally {
		timer.mockRestore();
		clearTimer.mockRestore();
		closeQuietly(db);
	}
}

function assertFits(lines: string[], width: number, rows: number) {
	expect(lines.length).toBeLessThanOrEqual(rows);
	expect(lines[0]?.startsWith("╭")).toBe(true);
	expect(lines.at(-1)?.startsWith("╰")).toBe(true);
	for (const line of lines)
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
}

function visibleRange(lines: string[]) {
	const match = lines.at(-2)?.match(/(\d+)-(\d+)\/(\d+)/);
	expect(match).not.toBeNull();
	return {
		first: Number(match?.[1]),
		last: Number(match?.[2]),
		total: Number(match?.[3]),
	};
}

function assertBottom(dialog: Dialog, width: number, rows: number) {
	const lines = dialog.render(width);
	assertFits(lines, width, rows);
	const range = visibleRange(lines);
	expect(range.last).toBe(range.total);
	expect(lines.join("\n")).toContain("Injected");
	return lines;
}

describe("Pi status dialog scrolling", () => {
	it("fits the rows host viewport without a legacy terminal object", async () => {
		await withDialog(
			(dialog, { terminal, requestRender }) => {
				terminal.rows = 9;
				const initial = dialog.render(78);
				assertFits(initial, 78, terminal.rows);
				dialog.handleInput(keys.down);
				expect(requestRender).toHaveBeenCalledTimes(1);
				expect(visibleRange(dialog.render(78)).first).toBe(2);
			},
			false,
			true,
		);
	});

	it("keeps the title, close hint and bottom border visible in a short terminal", async () => {
		await withDialog((dialog, { terminal }) => {
			const lines = dialog.render(78);
			assertFits(lines, 78, terminal.rows);
			expect(lines[1]).toContain("Magic Context Status");
			expect(lines.at(-2)).toContain("Esc to close");
			expect(lines.at(-2)).toContain("scroll");
		});
	});

	it("fits the footer to its text width without truncating optional controls", async () => {
		await withDialog((dialog, { terminal }) => {
			for (const rows of [5, 24]) {
				terminal.rows = rows;
				for (const width of [16, 24, 40, 60]) {
					dialog.render(width);
					dialog.handleInput(keys.end);
					const lines = dialog.render(width);
					assertFits(lines, width, rows);
					const footer = lines.at(-2) ?? "";
					expect(footer).toContain("Esc to close");
					expect(footer).not.toContain("…");
					if (width === 60) {
						expect(footer).toContain("↑↓/PgUp/PgDn/Home/End scroll");
					} else if (width === 40) {
						expect(footer).toContain("↑↓");
						expect(footer).not.toContain("PgUp");
					} else {
						expect(footer).not.toContain("↑↓");
					}
				}
			}
		});
	});

	it("scrolls by a row or page, reaches the last data and clamps both endpoints", async () => {
		await withDialog((dialog, { terminal, requestRender }) => {
			terminal.rows = 12;
			const top = dialog.render(78);
			expect(visibleRange(top).first).toBe(1);
			dialog.handleInput(keys.up);
			dialog.handleInput(keys.pageUp);
			expect(dialog.render(78)).toEqual(top);
			requestRender.mockClear();
			dialog.handleInput(keys.down);
			expect(requestRender).toHaveBeenCalled();
			const down = dialog.render(78);
			expect(visibleRange(down).first).toBe(2);
			expect(down[0]).toBe(top[0]);
			expect(down[1]).toBe(top[1]);
			expect(down.at(-1)).toBe(top.at(-1));
			expect(down.slice(2, -3)).toEqual(top.slice(3, -2));
			dialog.handleInput(keys.up);
			expect(dialog.render(78)).toEqual(top);
			dialog.handleInput(keys.pageDown);
			expect(visibleRange(dialog.render(78)).first).toBe(9);
			dialog.handleInput(keys.pageUp);
			expect(dialog.render(78)).toEqual(top);
			dialog.handleInput(keys.end);
			const bottom = assertBottom(dialog, 78, terminal.rows);
			dialog.handleInput(keys.down);
			dialog.handleInput(keys.pageDown);
			expect(dialog.render(78)).toEqual(bottom);
			dialog.handleInput(keys.home);
			expect(dialog.render(78)).toEqual(top);
			dialog.handleInput("d");
			expect(dialog.render(78)).toEqual(top);
		});
	});

	it("keeps every body row reachable through the viewport", async () => {
		await withDialog((dialog, { terminal }) => {
			terminal.rows = 100;
			const full = dialog.render(78);
			const expectedBody = full.slice(2, -2);
			terminal.rows = 5;
			const seen: string[] = [];
			for (let i = 0; i < expectedBody.length; i++) {
				const lines = dialog.render(78);
				assertFits(lines, 78, terminal.rows);
				seen.push(lines[2] ?? "");
				dialog.handleInput(keys.down);
			}
			expect(seen).toEqual(expectedBody);
		});
	});

	it("retains the complete presentation and ignores scrolling when content fits", async () => {
		await withDialog((dialog, { terminal }) => {
			terminal.rows = 100;
			const full = dialog.render(78);
			assertFits(full, 78, terminal.rows);
			expect(full.join("\n")).toContain("Context Details");
			expect(full.join("\n")).toContain("Injected");
			expect(full.at(-2)).toContain("Esc to close");
			expect(full.at(-2)).not.toContain("scroll");
			for (const key of Object.values(keys)) {
				dialog.handleInput(key);
				expect(dialog.render(78)).toEqual(full);
			}
		});
	});

	it("clamps after height changes and real single/two-column transitions", async () => {
		await withDialog((dialog, { terminal }) => {
			terminal.rows = 100;
			const single = dialog.render(40);
			const double = dialog.render(110);
			expect(single.some((line) => /Tags\s+Reductions/.test(line))).toBe(false);
			expect(double.some((line) => /Tags\s+Reductions/.test(line))).toBe(true);
			terminal.rows = 12;
			dialog.render(40);
			dialog.handleInput(keys.end);
			assertBottom(dialog, 40, terminal.rows);
			// The two-column body is shorter, so the old offset must be clamped.
			const doubleBottom = assertBottom(dialog, 110, terminal.rows);
			dialog.handleInput(keys.end);
			expect(dialog.render(110)).toEqual(doubleBottom);
			assertFits(dialog.render(40), 40, terminal.rows);
			dialog.handleInput(keys.end);
			assertBottom(dialog, 40, terminal.rows);
			terminal.rows = 24;
			assertBottom(dialog, 40, terminal.rows);
			terminal.rows = 100;
			expect(dialog.render(40)).toEqual(single);
			terminal.rows = 12;
			expect(visibleRange(dialog.render(40)).first).toBe(1);
		}, true);
	});

	it("preserves refresh position and clamps when refreshed content shrinks", async () => {
		await withDialog((dialog, { deps, terminal, refresh, requestRender }) => {
			dialog.render(78);
			dialog.handleInput(keys.pageDown);
			const before = dialog.render(78);
			refresh();
			expect(requestRender).toHaveBeenCalled();
			expect(dialog.render(78)).toEqual(before);
			// Adding/removing a real Status section changes the body length.
			deps.configGeneration = 1;
			deps.configAdoptedAt = 1730000000000;
			refresh();
			const grown = dialog.render(78);
			expect(visibleRange(grown).first).toBe(visibleRange(before).first);
			expect(visibleRange(grown).total).toBeGreaterThan(
				visibleRange(before).total,
			);
			dialog.handleInput(keys.end);
			const grownBottom = assertBottom(dialog, 78, terminal.rows);
			delete deps.configGeneration;
			refresh();
			const shrunk = assertBottom(dialog, 78, terminal.rows);
			expect(visibleRange(shrunk).total).toBeLessThan(
				visibleRange(grownBottom).total,
			);
			dialog.handleInput(keys.end);
			expect(dialog.render(78)).toEqual(shrunk);
		});
	});

	it("fits narrow and short terminals at both scroll endpoints", async () => {
		await withDialog((dialog, { terminal }) => {
			for (const width of [24, 40, 78, 110]) {
				for (const rows of [5, 12, 24, 60]) {
					terminal.rows = rows;
					dialog.handleInput(keys.home);
					const top = dialog.render(width);
					assertFits(top, width, rows);
					expect(top.at(-2)).toContain("Esc to close");
					dialog.handleInput(keys.end);
					const bottom = dialog.render(width);
					assertFits(bottom, width, rows);
					expect(bottom.at(-2)).toContain("Esc to close");
				}
			}
		});
	});

	it("degrades safely when there is not enough space for the full frame", async () => {
		await withDialog((dialog, { terminal }) => {
			for (const rows of [0, 1, 2, 3, 4, 5]) {
				terminal.rows = rows;
				for (const width of [0, 1, 2, 3, 4, 12, 16, 24]) {
					const lines = dialog.render(width);
					expect(lines.length).toBeLessThanOrEqual(rows);
					for (const line of lines)
						expect(visibleWidth(line)).toBeLessThanOrEqual(width);
					if (rows >= 2 && width >= (rows < 5 ? 12 : 16))
						expect(lines.join("\n")).toContain("Esc to close");
				}
			}
		});
	});

	it("preserves close keys and releases its refresh timer exactly once", async () => {
		for (const key of ["\x1b", "\r", "\x03"]) {
			await withDialog(
				(dialog, { done, clearTimer, refresh, requestRender }) => {
					dialog.render(78);
					dialog.handleInput(keys.end);
					dialog.handleInput(key);
					expect(done).toHaveBeenCalledTimes(1);
					expect(clearTimer).toHaveBeenCalledTimes(1);
					expect(clearTimer).toHaveBeenCalledWith(123);
					requestRender.mockClear();
					refresh();
					dialog.handleInput(keys.down);
					expect(requestRender).not.toHaveBeenCalled();
					dialog.handleInput(key);
					stopStatusDialogRefresh();
					dialog.dispose();
					expect(done).toHaveBeenCalledTimes(1);
					expect(clearTimer).toHaveBeenCalledTimes(1);
				},
			);
		}
	});

	it("shutdown closes a scrolled dialog and prevents later refreshes", async () => {
		await withDialog((dialog, { done, clearTimer, refresh, requestRender }) => {
			dialog.render(78);
			dialog.handleInput(keys.end);
			stopStatusDialogRefresh();
			expect(done).toHaveBeenCalledTimes(1);
			expect(clearTimer).toHaveBeenCalledTimes(1);
			requestRender.mockClear();
			refresh();
			expect(requestRender).not.toHaveBeenCalled();
			stopStatusDialogRefresh();
			expect(done).toHaveBeenCalledTimes(1);
		});
	});
});
