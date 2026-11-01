import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { bytesFromMuralImage, muralDisplaySrc, pngDataUrl } from "./mural-image";

// 1×1 PNG. The signature is what a failed conversion would drop first.
const PNG = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0,
  0, 144, 119, 83, 222, 0, 0, 0, 12, 73, 68, 65, 84, 8, 215, 99, 248, 207, 192, 0, 0, 3, 1, 1, 0,
  24, 221, 141, 176, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

function roundTrip(image: unknown): Uint8Array {
  const shown = muralDisplaySrc(image);
  expect(shown).not.toBeNull();
  if (!shown) throw new Error("missing src");
  try {
    expect(shown.src.startsWith("blob:") || shown.src.startsWith("data:image/png;base64,")).toBe(
      true,
    );
    if (shown.src.startsWith("blob:")) {
      return (
        bytesFromMuralImage(pngDataUrl(bytesFromMuralImage(image) ?? new Uint8Array())) ??
        new Uint8Array()
      );
    }
    return bytesFromMuralImage(shown.src) ?? new Uint8Array();
  } finally {
    shown.revoke();
  }
}

describe("mural image display", () => {
  test("a byte array becomes a PNG the image element can decode", () => {
    const restored = bytesFromMuralImage(pngDataUrl(PNG));
    expect(restored).toEqual(PNG);
    expect(Array.from(restored ?? []).slice(0, 8)).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  test("IPC byte arrays, views, and data URLs all keep the PNG bytes", () => {
    expect(Array.from(roundTrip(Array.from(PNG)).slice(0, 8))).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);
    expect(bytesFromMuralImage(PNG)).toEqual(PNG);
    expect(bytesFromMuralImage(PNG.buffer)).toEqual(PNG);
    expect(bytesFromMuralImage(`data:image/png;base64,${pngDataUrl(PNG).split(",")[1]}`)).toEqual(
      PNG,
    );
  });

  test("a mural larger than one conversion chunk round-trips", () => {
    const bytes = new Uint8Array(0x8000 + 3);
    bytes.set(PNG.subarray(0, 8), 0);
    bytes[0x8000] = 255;
    bytes[0x8001] = 0;
    bytes[0x8002] = 7;
    expect(bytesFromMuralImage(pngDataUrl(bytes))).toEqual(bytes);
  });

  test("an empty or corrupt image does not invent a URL", () => {
    expect(muralDisplaySrc([])).toBeNull();
    expect(muralDisplaySrc("")).toBeNull();
    expect(muralDisplaySrc("not base64 !!!")).toBeNull();
    expect(muralDisplaySrc([1, 256])).toBeNull();
  });

  test("desktop and serve image policies allow the mural URL without a wider file scope", () => {
    const root = new URL("../../../", import.meta.url);
    const tauri = readFileSync(new URL("src-tauri/tauri.conf.json", root), "utf8");
    const serve = readFileSync(new URL("src-tauri/src/serve/mod.rs", root), "utf8");
    const capabilities = readFileSync(new URL("src-tauri/capabilities/default.json", root), "utf8");
    for (const source of [tauri, serve]) {
      const imgSrc = source.match(/img-src[^;"]*/)?.[0] ?? "";
      expect(imgSrc).toContain("blob:");
      expect(imgSrc).toContain("data:");
    }
    expect(capabilities).not.toContain("shell:default");
    expect(capabilities).not.toContain("asset:");
  });
});
