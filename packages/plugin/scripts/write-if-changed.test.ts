import { expect, test } from "bun:test";
import { mkdir, readFile, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { createTestTempDir } from "../src/shared/test-temp-dir";
import { writeIfChanged } from "./write-if-changed";

test("generated output creates missing parent directories and writes exact bytes", async () => {
    const { dir } = createTestTempDir("tui-write-if-changed-");
    const output = join(dir, "nested/output.ts");
    const content = Buffer.from("export const value = 'π';\n");
    expect(await writeIfChanged(output, content)).toBe(true);
    expect(await readFile(output)).toEqual(content);
});

test("identical generated strings and copied buffers preserve output mtime and inode", async () => {
    const { dir } = createTestTempDir("tui-write-if-changed-");
    const output = join(dir, "output.tsx");
    const content = "export const value = 'π';\n";
    await writeIfChanged(output, content);
    await utimes(output, 1, 1);
    const before = await stat(output);
    expect(await writeIfChanged(output, content)).toBe(false);
    expect(await writeIfChanged(output, Buffer.from(content))).toBe(false);
    const after = await stat(output);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);
});

test("changed generated output replaces bytes in place without replacing the inode", async () => {
    const { dir } = createTestTempDir("tui-write-if-changed-");
    const output = join(dir, "output.ts");
    await writeIfChanged(output, "old");
    await utimes(output, 1, 1);
    const before = await stat(output);
    expect(await writeIfChanged(output, "new")).toBe(true);
    expect(await readFile(output, "utf8")).toBe("new");
    const after = await stat(output);
    expect(after.mtimeMs).not.toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);
});

test("generated output does not hide read errors other than missing files", async () => {
    const { dir } = createTestTempDir("tui-write-if-changed-");
    const output = join(dir, "directory.ts");
    await mkdir(output);
    await expect(writeIfChanged(output, "content")).rejects.toThrow();
});
