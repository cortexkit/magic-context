import { describe, expect, test } from "bun:test";
import { estimateImageTokensFromDataUrl } from "./image-token-estimate";

function makePngDataUrl(width: number, height: number): string {
    // Minimum valid PNG header + IHDR chunk with correct width/height.
    // We don't need full chunks — our parser only reads offsets 16-23.
    const buf = new Uint8Array(24);
    // PNG magic
    buf[0] = 0x89;
    buf[1] = 0x50;
    buf[2] = 0x4e;
    buf[3] = 0x47;
    buf[4] = 0x0d;
    buf[5] = 0x0a;
    buf[6] = 0x1a;
    buf[7] = 0x0a;
    // IHDR length placeholder (bytes 8-11) and type "IHDR" (12-15) — parser ignores these
    buf[8] = 0;
    buf[9] = 0;
    buf[10] = 0;
    buf[11] = 13;
    buf[12] = 0x49;
    buf[13] = 0x48;
    buf[14] = 0x44;
    buf[15] = 0x52;
    // Width (16-19) big-endian
    buf[16] = (width >>> 24) & 0xff;
    buf[17] = (width >>> 16) & 0xff;
    buf[18] = (width >>> 8) & 0xff;
    buf[19] = width & 0xff;
    // Height (20-23) big-endian
    buf[20] = (height >>> 24) & 0xff;
    buf[21] = (height >>> 16) & 0xff;
    buf[22] = (height >>> 8) & 0xff;
    buf[23] = height & 0xff;
    const binary = Array.from(buf)
        .map((b) => String.fromCharCode(b))
        .join("");
    return `data:image/png;base64,${btoa(binary)}`;
}

describe("estimateImageTokensFromDataUrl", () => {
    test("PNG 1024x768 (typical screenshot)", () => {
        // Formula: (1024 × 768) / 750 = 1048.58 → ceil = 1049
        const tokens = estimateImageTokensFromDataUrl(makePngDataUrl(1024, 768));
        expect(tokens).toBe(1049);
    });

    test("PNG 2560x1440 (retina screenshot)", () => {
        // (2560 × 1440) / 750 = 4915.2 → ceil = 4916 → clamped to 4500
        const tokens = estimateImageTokensFromDataUrl(makePngDataUrl(2560, 1440));
        expect(tokens).toBe(4500);
    });

    test("PNG 400x300 (small image)", () => {
        // (400 × 300) / 750 = 160
        const tokens = estimateImageTokensFromDataUrl(makePngDataUrl(400, 300));
        expect(tokens).toBe(160);
    });

    test("PNG 100x100 (tiny)", () => {
        const tokens = estimateImageTokensFromDataUrl(makePngDataUrl(100, 100));
        // (100 * 100) / 750 = 13.33 → ceil 14
        expect(tokens).toBe(14);
    });

    test("falls back on unparseable data url", () => {
        const tokens = estimateImageTokensFromDataUrl("data:image/png;base64,garbage");
        expect(tokens).toBeGreaterThan(0);
        expect(tokens).toBeLessThanOrEqual(4500);
    });

    test("falls back on missing comma", () => {
        const tokens = estimateImageTokensFromDataUrl("data:image/png;base64garbage");
        expect(tokens).toBeGreaterThan(0);
    });
});
