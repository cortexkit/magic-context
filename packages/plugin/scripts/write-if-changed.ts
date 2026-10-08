import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Preserve output mtimes and inodes when generation produced identical bytes. */
export async function writeIfChanged(path: string, content: string | Uint8Array): Promise<boolean> {
    const bytes = Buffer.from(content);
    try {
        if ((await readFile(path)).equals(bytes)) return false;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return true;
}
