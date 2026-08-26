/// <reference types="bun-types" />

import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	clearCachedModule,
	defaultLoaders,
	loadDefaultPiSessionApi,
	type ModuleLoader,
	resolvePiCodingAgentModule,
} from "./pi-session-api";

const PI_SPEC = "@earendil-works/pi-coding-agent";

/** A fixture module whose listAll returns a unique marker, so tests can tell
 * WHICH copy of pi-coding-agent was resolved through the public API. */
function fixtureModule(marker: string): string {
	return (
		`export const __piShimFakeMarker = ${JSON.stringify(marker)};\n` +
		`export const SessionManager = { listAll: async () => [${JSON.stringify(marker)}] };\n`
	);
}

/** Write a fake pi-coding-agent package rooted at pkgRoot. */
function writeFixturePackage(
	pkgRoot: string,
	opts: {
		version?: string;
		entry?: string;
		/** Full manifest override — use for shapes the default can't express. */
		manifest?: Record<string, unknown>;
		files: Record<string, string>;
	},
): void {
	mkdirSync(pkgRoot, { recursive: true });
	writeFileSync(
		join(pkgRoot, "package.json"),
		JSON.stringify(
			opts.manifest ?? {
				name: PI_SPEC,
				version: opts.version ?? "9.9.9",
				exports: { ".": { import: opts.entry ?? "./index.js" } },
			},
		),
	);
	for (const [rel, content] of Object.entries(opts.files)) {
		const p = join(pkgRoot, rel);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, content);
	}
}

/** Loader that stands in for "the next strategy" when the first must fail. */
function fallbackLoader(marker = "fallback-used"): ModuleLoader {
	return {
		name: "Fallback",
		load: async () => ({
			SessionManager: { listAll: async () => [marker] },
		}),
	};
}

/** Run fn with process.argv[1] temporarily replaced (undefined = no script arg). */
async function withArgv1<T>(
	argv1: string | undefined,
	fn: () => Promise<T>,
): Promise<T> {
	const origArgv = process.argv;
	Object.defineProperty(process, "argv", {
		value: argv1 === undefined ? [process.execPath] : [process.execPath, argv1],
		configurable: true,
	});
	try {
		return await fn();
	} finally {
		Object.defineProperty(process, "argv", {
			value: origArgv,
			configurable: true,
		});
	}
}

/**
 * These tests exercise the DEFAULT resolution path against the actually
 * installed pi-coding-agent package. The Pi session-listing API drifted once
 * (`SessionManager.listSessions` never existed publicly) and the providers'
 * dependency-injected unit tests could not catch it — every test supplied its
 * own listSessions stub, so the broken default lookup only failed at runtime
 * inside the dreamer. This is the missing coverage: if pi-coding-agent renames
 * or removes the session APIs again, this fails in CI instead of silently
 * degrading retrospective/refresh-primers.
 */
describe("loadDefaultPiSessionApi", () => {
	beforeEach(() => {
		clearCachedModule();
	});

	it("resolves the session APIs from the installed pi-coding-agent", async () => {
		const api = await loadDefaultPiSessionApi();
		expect(typeof api.listSessions).toBe("function");
		expect(typeof api.loadEntriesFromFile).toBe("function");
	}, 30000);

	it("parses JSONL session entries through the resolved loader", async () => {
		const api = await loadDefaultPiSessionApi();

		const dir = mkdtempSync(join(tmpdir(), "pi-session-api-test-"));
		const file = join(dir, "session.jsonl");
		const entry = {
			type: "message",
			id: "e1",
			message: {
				role: "user",
				timestamp: 123,
				content: [{ type: "text", text: "hello" }],
			},
		};
		writeFileSync(file, `${JSON.stringify(entry)}\n`);

		const entries = await api.loadEntriesFromFile(file);
		expect(Array.isArray(entries)).toBe(true);
		expect(entries.length).toBeGreaterThan(0);
	}, 30000);

	describe("default loader order", () => {
		it('first default loader is "Resolve from running Pi binary entry" (prefer the running Pi version)', () => {
			const names = defaultLoaders.map((l) => l.name);
			expect(names[0]).toBe("Resolve from running Pi binary entry");
			expect(names).toContain("Bare import");
		});

		it("resolves through a bin-shim symlink when argv[1] is the shim path", async () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-symlink-test-"));
			const pkgRoot = join(
				dir,
				"node_modules",
				"@earendil-works",
				"pi-coding-agent",
			);
			writeFixturePackage(pkgRoot, {
				files: { "index.js": fixtureModule("fake-9.9.9") },
			});
			// bin shim: bin/pi -> <pkgRoot>/index.js (a symlink to the real entry)
			const binDir = join(dir, "bin");
			mkdirSync(binDir, { recursive: true });
			const shim = join(binDir, "pi");
			symlinkSync(join(pkgRoot, "index.js"), shim);

			const origCwd = process.cwd();
			try {
				process.chdir(dir);
				await withArgv1(shim, async () => {
					clearCachedModule();
					const api = await loadDefaultPiSessionApi();
					expect(typeof api.listSessions).toBe("function");
					expect(typeof api.loadEntriesFromFile).toBe("function");
					// End-to-end through the PUBLIC resolve path: the fixture's
					// listAll marker must come back. If the symlink walk broke and
					// the bare-import fallback rescued resolution, the REAL
					// installed package's sessions would come back instead and
					// this assertion fails — the fallback cannot green this test.
					expect(await api.listSessions()).toEqual(["fake-9.9.9"]);
					// Belt and braces: the fake copy also exports a module marker
					// the real installed pi-coding-agent does not.
					const mod = (await resolvePiCodingAgentModule(defaultLoaders)) as {
						__piShimFakeMarker?: string;
					};
					expect(mod.__piShimFakeMarker).toBe("fake-9.9.9");
				});
				expect(realpathSync(shim)).toBe(
					realpathSync(join(pkgRoot, "index.js")),
				);
			} finally {
				process.chdir(origCwd);
			}
		}, 30000);
	});

	describe("running-Pi resolver layouts", () => {
		it("prefers the running Pi over a stale extension-tree copy", async () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-running-vs-stale-"));
			const pkgRoot = join(
				dir,
				"node_modules",
				"@earendil-works",
				"pi-coding-agent",
			);
			writeFixturePackage(pkgRoot, {
				files: { "index.js": fixtureModule("running-pi-9.9.9") },
			});

			// The bare import resolves a STALE extension-tree copy. mock.module
			// makes that copy observable: if the running-Pi resolver breaks and
			// the bare import rescues resolution, the stale marker comes back
			// and this test fails instead of greening on the fallback.
			const originalModule = await import(PI_SPEC);
			mock.module(PI_SPEC, () => ({
				SessionManager: { listAll: async () => ["stale-extension-tree-copy"] },
			}));
			try {
				await withArgv1(join(pkgRoot, "index.js"), async () => {
					clearCachedModule();
					const api = await loadDefaultPiSessionApi();
					expect(await api.listSessions()).toEqual(["running-pi-9.9.9"]);
				});
			} finally {
				mock.module(PI_SPEC, () => originalModule);
				clearCachedModule();
			}
		}, 30000);

		it("skips Pi's copied dist/package.json and resolves the parent package root", async () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-dist-metadata-"));
			const pkgRoot = join(dir, "pi-coding-agent");
			writeFixturePackage(pkgRoot, {
				entry: "./dist/index.js",
				files: {
					"dist/index.js": fixtureModule("parent-root-9.9.9"),
					"dist/cli.js": "// binary entry\n",
					// build:binary copies this metadata into dist/. Stopping the
					// walk here would resolve ./dist/index.js against dist/ and
					// construct dist/dist/index.js.
					"dist/package.json": JSON.stringify({
						name: PI_SPEC,
						version: "9.9.9",
						exports: { ".": { import: "./dist/index.js" } },
					}),
				},
			});
			await withArgv1(join(pkgRoot, "dist", "cli.js"), async () => {
				clearCachedModule();
				const api = await loadDefaultPiSessionApi();
				expect(await api.listSessions()).toEqual(["parent-root-9.9.9"]);
			});
		}, 30000);

		it("rejects a manifest entry that escapes the package root", async () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-traversal-"));
			const pkgRoot = join(dir, "pi-coding-agent");
			writeFixturePackage(pkgRoot, {
				entry: "../../outside.js",
				files: { "cli.js": "// entry\n" },
			});
			await withArgv1(join(pkgRoot, "cli.js"), async () => {
				clearCachedModule();
				const fallback: ModuleLoader = {
					name: "Fallback",
					load: async () => ({
						SessionManager: { listAll: async () => ["fallback-used"] },
					}),
				};
				// The escaping entry must be rejected, falling through to the
				// next loader rather than importing a path outside the package.
				const api = await loadDefaultPiSessionApi([
					defaultLoaders[0],
					fallback,
				]);
				expect(await api.listSessions()).toEqual(["fallback-used"]);
			});
		}, 30000);

		it("running from a TypeScript source checkout loads the source entry, not stale dist output", async () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-source-mode-"));
			const pkgRoot = join(dir, "pi-coding-agent");
			writeFixturePackage(pkgRoot, {
				entry: "./dist/index.js",
				files: {
					"src/cli.ts": "// source entry (tsx/jiti)\n",
					"src/index.ts": fixtureModule("source-checkout"),
					// Stale build output left behind by an old build — must NOT win.
					"dist/index.js": fixtureModule("stale-dist-output"),
				},
			});
			await withArgv1(join(pkgRoot, "src", "cli.ts"), async () => {
				clearCachedModule();
				const api = await loadDefaultPiSessionApi();
				expect(await api.listSessions()).toEqual(["source-checkout"]);
			});
		}, 30000);

		it("source mode without a source counterpart falls through instead of loading stale dist", async () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-source-missing-"));
			const pkgRoot = join(dir, "pi-coding-agent");
			writeFixturePackage(pkgRoot, {
				entry: "./dist/index.js",
				files: {
					"src/cli.ts": "// source entry (tsx/jiti)\n",
					"dist/index.js": fixtureModule("stale-dist-output"),
				},
			});
			await withArgv1(join(pkgRoot, "src", "cli.ts"), async () => {
				clearCachedModule();
				const api = await loadDefaultPiSessionApi([
					defaultLoaders[0],
					fallbackLoader(),
				]);
				expect(await api.listSessions()).toEqual(["fallback-used"]);
			});
		}, 30000);

		describe("manifest entry validation", () => {
			// The "./" requirement applies to every manually joined manifest
			// target, not just exports: a non-prefixed "dist/index.js" in ANY
			// field must be rejected, falling through to the next loader.
			const nonPrefixedCases: Array<{
				label: string;
				manifest: Record<string, unknown>;
			}> = [
				{
					label: "exports string entry",
					manifest: {
						name: PI_SPEC,
						exports: { ".": "dist/index.js" },
					},
				},
				{
					label: "exports import condition",
					manifest: {
						name: PI_SPEC,
						exports: { ".": { import: "dist/index.js" } },
					},
				},
				{
					label: "module field",
					manifest: { name: PI_SPEC, module: "dist/index.js" },
				},
				{
					label: "main field",
					manifest: { name: PI_SPEC, main: "dist/index.js" },
				},
			];
			for (const { label, manifest } of nonPrefixedCases) {
				it(`rejects a non-prefixed entry in ${label}`, async () => {
					const dir = mkdtempSync(join(tmpdir(), "pi-nonprefixed-"));
					const pkgRoot = join(dir, "pi-coding-agent");
					writeFixturePackage(pkgRoot, {
						manifest,
						files: {
							"cli.js": "// entry\n",
							"dist/index.js": fixtureModule("must-not-load"),
						},
					});
					await withArgv1(join(pkgRoot, "cli.js"), async () => {
						clearCachedModule();
						const api = await loadDefaultPiSessionApi([
							defaultLoaders[0],
							fallbackLoader(),
						]);
						expect(await api.listSessions()).toEqual(["fallback-used"]);
					});
				}, 30000);
			}

			it("resolves the default condition when no import condition exists", async () => {
				const dir = mkdtempSync(join(tmpdir(), "pi-default-cond-"));
				const pkgRoot = join(dir, "pi-coding-agent");
				writeFixturePackage(pkgRoot, {
					manifest: {
						name: PI_SPEC,
						exports: {
							".": {
								types: "./index.d.ts",
								default: "./index.js",
							},
						},
					},
					files: { "index.js": fixtureModule("default-condition") },
				});
				await withArgv1(join(pkgRoot, "index.js"), async () => {
					clearCachedModule();
					const api = await loadDefaultPiSessionApi();
					expect(await api.listSessions()).toEqual(["default-condition"]);
				});
			}, 30000);

			it("resolves array exports by falling back to the first resolvable target", async () => {
				const dir = mkdtempSync(join(tmpdir(), "pi-array-exports-"));
				const pkgRoot = join(dir, "pi-coding-agent");
				writeFixturePackage(pkgRoot, {
					manifest: {
						name: PI_SPEC,
						// First element is a require-only conditional (no import /
						// node / default) — unresolvable for us; the array fallback
						// must advance to the plain string target.
						exports: {
							".": [{ require: "./index.cjs" }, "./index.js"],
						},
					},
					files: { "index.js": fixtureModule("array-fallback") },
				});
				await withArgv1(join(pkgRoot, "index.js"), async () => {
					clearCachedModule();
					const api = await loadDefaultPiSessionApi();
					expect(await api.listSessions()).toEqual(["array-fallback"]);
				});
			}, 30000);
		});

		describe("script entry whitelist", () => {
			it("accepts an extensionless bin-style entry script", async () => {
				const dir = mkdtempSync(join(tmpdir(), "pi-extensionless-"));
				const pkgRoot = join(dir, "pi-coding-agent");
				writeFixturePackage(pkgRoot, {
					files: {
						// bin-style entry with no file extension (e.g. dist/cli)
						cli: "// extensionless entry\n",
						"index.js": fixtureModule("extensionless-entry"),
					},
				});
				await withArgv1(join(pkgRoot, "cli"), async () => {
					clearCachedModule();
					const api = await loadDefaultPiSessionApi();
					expect(await api.listSessions()).toEqual(["extensionless-entry"]);
				});
			}, 30000);

			it("running from a .tsx source checkout loads the source entry, not stale dist", async () => {
				const dir = mkdtempSync(join(tmpdir(), "pi-tsx-source-"));
				const pkgRoot = join(dir, "pi-coding-agent");
				writeFixturePackage(pkgRoot, {
					entry: "./dist/index.jsx",
					files: {
						"src/cli.tsx": "// source entry (tsx/jiti)\n",
						"src/index.tsx": fixtureModule("tsx-source-checkout"),
						"dist/index.jsx": fixtureModule("stale-dist-output"),
					},
				});
				await withArgv1(join(pkgRoot, "src", "cli.tsx"), async () => {
					clearCachedModule();
					const api = await loadDefaultPiSessionApi();
					expect(await api.listSessions()).toEqual(["tsx-source-checkout"]);
				});
			}, 30000);
		});
	});

	describe("resolution ladder mechanics", () => {
		it("ladder order: first loader succeeds -> second never called", async () => {
			const firstLoaderCalled = mock(() =>
				Promise.resolve({ SessionManager: { listAll: () => [] } }),
			);
			const secondLoaderCalled = mock(() =>
				Promise.resolve({ SessionManager: { listAll: () => [] } }),
			);

			const loaders: ModuleLoader[] = [
				{ name: "First", load: firstLoaderCalled },
				{ name: "Second", load: secondLoaderCalled },
			];

			const api = await loadDefaultPiSessionApi(loaders);
			expect(firstLoaderCalled).toHaveBeenCalledTimes(1);
			expect(secondLoaderCalled).not.toHaveBeenCalled();
			expect(typeof api.listSessions).toBe("function");
		});

		it("first loader throws ERR_MODULE_NOT_FOUND -> second loader's module used", async () => {
			const firstLoaderCalled = mock(() =>
				Promise.reject(new Error("Cannot find module")),
			);
			const secondLoaderCalled = mock(() =>
				Promise.resolve({ SessionManager: { listAll: () => [] } }),
			);

			const loaders: ModuleLoader[] = [
				{ name: "First", load: firstLoaderCalled },
				{ name: "Second", load: secondLoaderCalled },
			];

			const api = await loadDefaultPiSessionApi(loaders);
			expect(firstLoaderCalled).toHaveBeenCalledTimes(1);
			expect(secondLoaderCalled).toHaveBeenCalledTimes(1);
			expect(typeof api.listSessions).toBe("function");
		});

		it("all loaders fail -> single aggregated error naming both strategies (assert message mentions the symlink/layout hint)", async () => {
			const firstLoaderCalled = mock(() =>
				Promise.reject(new Error("Cannot find module")),
			);
			const secondLoaderCalled = mock(() =>
				Promise.reject(new Error("process.argv[1] is undefined")),
			);

			const loaders: ModuleLoader[] = [
				{ name: "First", load: firstLoaderCalled },
				{ name: "Second", load: secondLoaderCalled },
			];

			let error: Error | null = null;
			try {
				await loadDefaultPiSessionApi(loaders);
			} catch (e: unknown) {
				error = e as Error;
			}

			expect(error).not.toBeNull();
			expect(error?.message).toContain(
				"Failed to resolve @earendil-works/pi-coding-agent via all strategies",
			);
			expect(error?.message).toContain("- First: Cannot find module");
			expect(error?.message).toContain(
				"- Second: process.argv[1] is undefined",
			);
			expect(error?.message).toContain(
				"symlinked or nonstandard install layout",
			);
		});

		it("missing argv[1] names the walked entry (execPath) in the error, not undefined", async () => {
			// Packaged-binary run: argv has no script path, so the loader falls
			// back to process.execPath; the upward walk cannot find
			// pi-coding-agent from there, and the error must name the path
			// actually walked rather than interpolating `undefined`.
			await withArgv1(undefined, async () => {
				const loaders: ModuleLoader[] = [defaultLoaders[0]];
				let error: Error | null = null;
				try {
					await loadDefaultPiSessionApi(loaders);
				} catch (e: unknown) {
					error = e as Error;
				}
				expect(error).not.toBeNull();
				expect(error?.message).toContain(
					"Could not locate @earendil-works/pi-coding-agent package.json from",
				);
				expect(error?.message).toContain(process.execPath);
				expect(error?.message).not.toContain("from undefined");
			});
		});

		it("memoization: two calls -> loaders invoked once", async () => {
			const loaderCalled = mock(() =>
				Promise.resolve({ SessionManager: { listAll: () => [] } }),
			);

			const loaders: ModuleLoader[] = [
				{ name: "SpyLoader", load: loaderCalled },
			];

			await loadDefaultPiSessionApi(loaders);
			await loadDefaultPiSessionApi(loaders);

			expect(loaderCalled).toHaveBeenCalledTimes(1);
		});
	});
});
