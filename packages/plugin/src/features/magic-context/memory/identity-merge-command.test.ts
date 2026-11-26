import { expect, test } from "bun:test";
import { identityMergeCommand } from "./identity-merge-command";

test.each([
    ["linux", "/work/old folder", "'/work/old folder'"],
    ["linux", "/work/owner's", String.raw`'/work/owner'\''s'`],
    ["win32", String.raw`C:\work\old folder`, String.raw`"C:\work\old folder"`],
    ["win32", String.raw`C:\work\owner's`, String.raw`"C:\work\owner's"`],
] as const)("quotes a folder on %s: %s", (platform, folder, quoted) => {
    expect(identityMergeCommand(folder, "git:new", platform)).toContain(`--from ${quoted} --to`);
});

test("builds a read-only preview even when the user must choose the destination", () => {
    expect(identityMergeCommand("dir:old", undefined, "linux")).toBe(
        'npx @cortexkit/magic-context@latest doctor merge-identities --from dir:old --to "DESTINATION_IDENTITY"',
    );
});
