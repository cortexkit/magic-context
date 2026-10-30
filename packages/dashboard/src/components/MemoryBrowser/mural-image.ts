const PNG_MIME = "image/png";
// Keep each fromCharCode spread under the engine argument limit. A 1092×1092
// mural PNG is larger than one call can take.
const BYTE_CHUNK = 0x8000;

export interface MuralDisplaySrc {
  src: string;
  /** Release a blob URL. A data URL has nothing to release. */
  revoke: () => void;
}

/**
 * Turn mural PNG bytes into an image URL the webview can paint.
 *
 * The bytes already arrived with the manifest (the caption renders from the
 * same object). Two things still leave the box blank:
 *
 * - The desktop content policy's default source is the app itself, which does
 *   not include `data:` or `blob:`. A blocked image shows the alt text and an
 *   empty box while the caption still renders. `img-src` must allow the scheme
 *   we use. This does not read a file, so it does not need a wider file scope.
 * - A full-size mural, base64-encoded, can exceed the webview's limit on
 *   `data:` URLs in an image source. A blob URL carries the same PNG with an
 *   explicit `image/png` type and is not subject to that URL-length limit.
 */
export function muralDisplaySrc(image: unknown): MuralDisplaySrc | null {
  const bytes = bytesFromMuralImage(image);
  if (!bytes) return null;
  if (canUseBlobUrl()) {
    // Copy into a plain ArrayBuffer. A view over SharedArrayBuffer is not a
    // Blob part, and the webview needs an owned PNG either way.
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    const blob = new Blob([copy], { type: PNG_MIME });
    const src = URL.createObjectURL(blob);
    return { src, revoke: () => URL.revokeObjectURL(src) };
  }
  return { src: pngDataUrl(bytes), revoke: () => {} };
}

export function bytesFromMuralImage(image: unknown): Uint8Array | null {
  if (typeof image === "string") return bytesFromEncoded(image);
  if (image instanceof ArrayBuffer) {
    return image.byteLength > 0 ? new Uint8Array(image) : null;
  }
  if (ArrayBuffer.isView(image)) {
    if (image.byteLength === 0) return null;
    return new Uint8Array(image.buffer, image.byteOffset, image.byteLength);
  }
  if (!Array.isArray(image) || image.length === 0) return null;
  const bytes = new Uint8Array(image.length);
  for (let index = 0; index < image.length; index++) {
    const value = image[index];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
      return null;
    }
    bytes[index] = value;
  }
  return bytes;
}

function bytesFromEncoded(image: string): Uint8Array | null {
  const payload = image.startsWith("data:") ? image.slice(image.indexOf(",") + 1) : image;
  if (!payload) return null;
  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

function canUseBlobUrl(): boolean {
  return (
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function" &&
    typeof Blob !== "undefined"
  );
}

export function pngDataUrl(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BYTE_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BYTE_CHUNK));
  }
  return `data:${PNG_MIME};base64,${btoa(binary)}`;
}
