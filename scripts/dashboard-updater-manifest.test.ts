import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type AssembleInput,
    assembleUpdaterManifest,
    runCli,
    UpdaterManifestError,
} from "./dashboard-updater-manifest";

const REPO = "cortexkit/magic-context";
const BASE_URL = `https://github.com/${REPO}/releases/latest/download/`;

// Platform key -> asset, copied from the latest.json of dashboard-v0.20.23, the
// last release whose manifest tauri-action merged without losing entries.
const EXPECTED_ENTRIES: Record<string, string> = {
    "darwin-aarch64": "magic-context-dashboard-darwin-arm64.app.tar.gz",
    "darwin-aarch64-app": "magic-context-dashboard-darwin-arm64.app.tar.gz",
    "darwin-x86_64": "magic-context-dashboard-darwin-x64.app.tar.gz",
    "darwin-x86_64-app": "magic-context-dashboard-darwin-x64.app.tar.gz",
    "linux-aarch64": "magic-context-dashboard-linux-arm64.AppImage",
    "linux-aarch64-appimage": "magic-context-dashboard-linux-arm64.AppImage",
    "linux-aarch64-deb": "magic-context-dashboard-linux-arm64.deb",
    "linux-aarch64-rpm": "magic-context-dashboard-linux-arm64.rpm",
    "linux-x86_64": "magic-context-dashboard-linux-x64.AppImage",
    "linux-x86_64-appimage": "magic-context-dashboard-linux-x64.AppImage",
    "linux-x86_64-deb": "magic-context-dashboard-linux-x64.deb",
    "linux-x86_64-rpm": "magic-context-dashboard-linux-x64.rpm",
    "windows-aarch64": "magic-context-dashboard-windows-arm64.exe",
    "windows-aarch64-nsis": "magic-context-dashboard-windows-arm64.exe",
    "windows-x86_64": "magic-context-dashboard-windows-x64.exe",
    "windows-x86_64-nsis": "magic-context-dashboard-windows-x64.exe",
    "windows-x86_64-msi": "magic-context-dashboard-windows-x64.msi",
};

// The asset list of a complete release (dashboard-v0.20.23 without its
// latest.json): every installer, every .sig, and the two macOS .dmg files,
// which have no signature and no manifest entry.
const FULL_RELEASE: readonly string[] = [
    "magic-context-dashboard-darwin-arm64.app.tar.gz",
    "magic-context-dashboard-darwin-arm64.app.tar.gz.sig",
    "magic-context-dashboard-darwin-arm64.dmg",
    "magic-context-dashboard-darwin-x64.app.tar.gz",
    "magic-context-dashboard-darwin-x64.app.tar.gz.sig",
    "magic-context-dashboard-darwin-x64.dmg",
    "magic-context-dashboard-linux-arm64.AppImage",
    "magic-context-dashboard-linux-arm64.AppImage.sig",
    "magic-context-dashboard-linux-arm64.deb",
    "magic-context-dashboard-linux-arm64.deb.sig",
    "magic-context-dashboard-linux-arm64.rpm",
    "magic-context-dashboard-linux-arm64.rpm.sig",
    "magic-context-dashboard-linux-x64.AppImage",
    "magic-context-dashboard-linux-x64.AppImage.sig",
    "magic-context-dashboard-linux-x64.deb",
    "magic-context-dashboard-linux-x64.deb.sig",
    "magic-context-dashboard-linux-x64.rpm",
    "magic-context-dashboard-linux-x64.rpm.sig",
    "magic-context-dashboard-windows-arm64.exe",
    "magic-context-dashboard-windows-arm64.exe.sig",
    "magic-context-dashboard-windows-x64.exe",
    "magic-context-dashboard-windows-x64.exe.sig",
    "magic-context-dashboard-windows-x64.msi",
    "magic-context-dashboard-windows-x64.msi.sig",
];

/** A distinct fake signature per .sig asset, so a swapped entry is caught. */
function fakeSignature(sigName: string): string {
    return Buffer.from(`untrusted comment: signature of ${sigName}`).toString("base64");
}

function input(assetNames: readonly string[], overrides: Partial<AssembleInput> = {}) {
    return {
        assetNames,
        readSignature: (sigName: string) =>
            assetNames.includes(sigName) ? fakeSignature(sigName) : undefined,
        repo: REPO,
        version: "0.21.0",
        pubDate: "2026-11-18T12:00:00.000Z",
        ...overrides,
    } satisfies AssembleInput;
}

function problemsOf(run: () => unknown): readonly string[] {
    try {
        run();
    } catch (error) {
        expect(error).toBeInstanceOf(UpdaterManifestError);
        return (error as UpdaterManifestError).problems;
    }
    throw new Error("expected assembleUpdaterManifest to throw");
}

describe("assembleUpdaterManifest", () => {
    test("a complete release gives the 17 platform entries of today's manifest", () => {
        const manifest = assembleUpdaterManifest(input(FULL_RELEASE));

        expect(manifest.version).toBe("0.21.0");
        expect(manifest.notes).toBe("");
        expect(manifest.pub_date).toBe("2026-11-18T12:00:00.000Z");
        expect(Object.keys(manifest.platforms).sort()).toEqual(
            Object.keys(EXPECTED_ENTRIES).sort(),
        );
        expect(Object.keys(manifest.platforms)).toHaveLength(17);
        for (const [key, asset] of Object.entries(EXPECTED_ENTRIES)) {
            expect(manifest.platforms[key]).toEqual({
                url: `${BASE_URL}${asset}`,
                signature: fakeSignature(`${asset}.sig`),
            });
        }
    });

    test("the signature is the .sig file content byte for byte", () => {
        const raw = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo=\n";
        const manifest = assembleUpdaterManifest(input(FULL_RELEASE, { readSignature: () => raw }));
        expect(manifest.platforms["linux-x86_64"]?.signature).toBe(raw);
    });

    test("a missing .sig fails and names its platform", () => {
        const assets = FULL_RELEASE.filter(
            (n) => n !== "magic-context-dashboard-linux-x64.deb.sig",
        );
        const problems = problemsOf(() => assembleUpdaterManifest(input(assets)));
        expect(problems).toEqual([
            "linux-x86_64-deb: release has no magic-context-dashboard-linux-x64.deb.sig",
        ]);
    });

    test("a missing installer fails and names every platform that points at it", () => {
        const assets = FULL_RELEASE.filter(
            (n) => n !== "magic-context-dashboard-linux-arm64.AppImage",
        );
        const problems = problemsOf(() => assembleUpdaterManifest(input(assets)));
        expect(problems).toEqual([
            "linux-aarch64, linux-aarch64-appimage: release has no magic-context-dashboard-linux-arm64.AppImage",
        ]);
    });

    test("every missing platform is reported, not just the first", () => {
        // What a re-run leg's merge produced in dashboard-v0.21.0: no Linux files at all.
        const assets = FULL_RELEASE.filter((n) => !n.includes("-linux-"));
        const problems = problemsOf(() => assembleUpdaterManifest(input(assets)));
        expect(problems).toHaveLength(6);
        const named = problems.join("\n");
        for (const key of Object.keys(EXPECTED_ENTRIES).filter((k) => k.startsWith("linux-"))) {
            expect(named).toContain(key);
        }
    });

    test("a .sig listed on the release but not downloaded fails", () => {
        const problems = problemsOf(() =>
            assembleUpdaterManifest(
                input(FULL_RELEASE, {
                    readSignature: (sigName) =>
                        sigName.includes("windows-x64.msi") ? undefined : fakeSignature(sigName),
                }),
            ),
        );
        expect(problems).toEqual([
            "windows-x86_64-msi: magic-context-dashboard-windows-x64.msi.sig is on the release but was not downloaded",
        ]);
    });

    test("an empty .sig fails and names its platform", () => {
        const problems = problemsOf(() =>
            assembleUpdaterManifest(
                input(FULL_RELEASE, {
                    readSignature: (sigName) =>
                        sigName.includes("darwin-arm64") ? "\n" : fakeSignature(sigName),
                }),
            ),
        );
        expect(problems).toEqual([
            "darwin-aarch64, darwin-aarch64-app: magic-context-dashboard-darwin-arm64.app.tar.gz.sig is empty",
        ]);
    });

    test("assets without a manifest entry are ignored", () => {
        const extras = [
            "latest.json",
            "magic-context-dashboard-linux-riscv64.AppImage",
            "magic-context-dashboard-linux-riscv64.AppImage.sig",
            "checksums.txt",
        ];
        const withExtras = assembleUpdaterManifest(input([...extras, ...FULL_RELEASE]));
        expect(withExtras).toEqual(assembleUpdaterManifest(input(FULL_RELEASE)));
    });
});

describe("runCli", () => {
    let dir: string | undefined;
    afterEach(() => {
        if (dir) rmSync(dir, { recursive: true, force: true });
        dir = undefined;
    });

    function setUp(assetNames: readonly string[]) {
        dir = mkdtempSync(join(tmpdir(), "dashboard-updater-manifest-"));
        const sigDir = join(dir, "sigs");
        mkdirSync(sigDir);
        for (const name of assetNames.filter((n) => n.endsWith(".sig"))) {
            writeFileSync(join(sigDir, name), fakeSignature(name));
        }
        const namesPath = join(dir, "assets.json");
        writeFileSync(namesPath, JSON.stringify(assetNames));
        const confPath = join(dir, "tauri.conf.json");
        writeFileSync(confPath, JSON.stringify({ version: "1.2.3" }));
        return { sigDir, namesPath, confPath, outPath: join(dir, "latest.json") };
    }

    test("writes latest.json from the asset list and the downloaded .sig files", () => {
        const { sigDir, namesPath, confPath, outPath } = setUp(FULL_RELEASE);
        const code = runCli([namesPath, sigDir, REPO, outPath], {
            confPath,
            now: () => new Date("2026-11-18T12:00:00.000Z"),
        });
        expect(code).toBe(0);
        const written = JSON.parse(readFileSync(outPath, "utf8"));
        expect(written).toEqual(assembleUpdaterManifest(input(FULL_RELEASE, { version: "1.2.3" })));
    });

    test("exits 1 without writing when a platform is incomplete", () => {
        const assets = FULL_RELEASE.filter(
            (n) => n !== "magic-context-dashboard-windows-arm64.exe.sig",
        );
        const { sigDir, namesPath, confPath, outPath } = setUp(assets);
        expect(runCli([namesPath, sigDir, REPO, outPath], { confPath })).toBe(1);
        expect(() => readFileSync(outPath)).toThrow();
    });

    test("exits 2 on a wrong argument count", () => {
        expect(runCli(["only-one"])).toBe(2);
    });
});
