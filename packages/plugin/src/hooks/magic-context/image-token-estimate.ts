// Image token estimation that matches Anthropic's vision billing formula.
//
// Anthropic vision docs: tokens ≈ (width × height) / 750
// https://docs.claude.com/en/build-with-claude/vision
//
// Images are sent inline as data URLs. Base64 char length is a terrible proxy
// (50x over-estimate for a typical screenshot), so we parse PNG/JPEG headers
// directly to read real pixel dimensions.

import { isRecord } from "../../shared/record-type-guard";

const IMAGE_TOKEN_DIVISOR = 750;
const IMAGE_FALLBACK_TOKENS = 1200; // ~ 950×950 mid-size image
const IMAGE_TOKEN_CAP = 4500; // Anthropic's max for a single image

/**
 * Estimate token cost of an image from its data URL.
 * Returns a conservative fallback when parsing fails.
 */
export function estimateImageTokensFromDataUrl(url: string): number {
    const comma = url.indexOf(",");
    if (comma < 0) return IMAGE_FALLBACK_TOKENS;
    return estimateImageTokensFromBase64(url.slice(0, comma), url.slice(comma + 1));
}

function estimateImageTokensFromBase64(header: string, payload: string): number {
    // Only decode the first 512 base64 characters (384 bytes): enough for the
    // PNG IHDR, GIF and WebP headers. JPEG reads further on demand below,
    // because an EXIF block before the frame header can run to 64 KiB.
    const sliceLen = Math.min(512, payload.length);
    const preview = payload.slice(0, sliceLen);

    let bytes: Uint8Array;
    try {
        bytes = base64Decode(preview);
    } catch {
        return IMAGE_FALLBACK_TOKENS;
    }

    return estimateImageTokensFromHeader(header, bytes, () =>
        createBase64ByteReader(payload, bytes),
    );
}

function estimateImageTokensFromHeader(
    header: string,
    bytes: Uint8Array,
    jpegReader: () => (offset: number) => number | undefined,
): number {
    if (header.includes("image/png")) {
        const dims = parsePngDimensions(bytes);
        if (dims) return clampImageTokens(Math.ceil((dims.w * dims.h) / IMAGE_TOKEN_DIVISOR));
    } else if (header.includes("image/jpeg") || header.includes("image/jpg")) {
        const dims = parseJpegDimensions(jpegReader());
        if (dims) return clampImageTokens(Math.ceil((dims.w * dims.h) / IMAGE_TOKEN_DIVISOR));
    } else if (header.includes("image/webp")) {
        const dims = parseWebpDimensions(bytes);
        if (dims) return clampImageTokens(Math.ceil((dims.w * dims.h) / IMAGE_TOKEN_DIVISOR));
    } else if (header.includes("image/gif")) {
        const dims = parseGifDimensions(bytes);
        if (dims) return clampImageTokens(Math.ceil((dims.w * dims.h) / IMAGE_TOKEN_DIVISOR));
    }

    return IMAGE_FALLBACK_TOKENS;
}

/** Read a live OpenCode 2 asset or the JSON form stored for replay. */
function nativeMediaImage(part: Record<string, unknown>) {
    if (part.type !== "media" || !isRecord(part.media)) return undefined;
    const { mediaType: assetMediaType, source } = part.media;
    // Media.Asset.toJSON omits the derived MIME type and encodes bytes as base64.
    const encoded = assetMediaType === undefined;
    const mediaType = encoded && isRecord(source) ? source.mediaType : assetMediaType;
    if (typeof mediaType !== "string" || !mediaType.startsWith("image/")) return undefined;
    let inline: string | Uint8Array | undefined;
    if (isRecord(source)) {
        const { type, data } = source;
        if (
            (type === "base64" || (encoded && type === "bytes")) &&
            typeof data === "string" &&
            data.length > 0
        )
            inline = data;
        if (!encoded && type === "bytes" && data instanceof Uint8Array && data.byteLength > 0)
            inline = data;
    }
    return { mediaType, inline };
}

export function isInlineNativeMediaImage(part: Record<string, unknown>): boolean {
    return nativeMediaImage(part)?.inline !== undefined;
}

export function estimateNativeMediaImageTokens(part: Record<string, unknown>): number {
    const image = nativeMediaImage(part);
    if (!image) return 0;
    const { mediaType, inline } = image;
    if (typeof inline === "string") return estimateImageTokensFromBase64(mediaType, inline);
    if (inline) return estimateImageTokensFromHeader(mediaType, inline, () => (i) => inline[i]);
    return IMAGE_FALLBACK_TOKENS;
}

/**
 * Image tokens of a tool part's `state.attachments`: the images a tool returned next to its
 * text output (OpenCode's `read` on a PNG, for example). The provider bills each one as an
 * image, so it is counted from its pixel dimensions, never from its base64 length. Other
 * attachment types stay uncounted, as they are for message file parts. Callers skip a
 * dropped output themselves: on OpenCode 2 the drop placeholder replaces the whole result,
 * images included.
 */
export function estimateToolAttachmentImageTokens(state: unknown): number {
    if (!state || typeof state !== "object") return 0;
    const attachments = (state as { attachments?: unknown }).attachments;
    if (!Array.isArray(attachments)) return 0;
    let tokens = 0;
    for (const attachment of attachments) {
        if (!attachment || typeof attachment !== "object") continue;
        const { mime, url } = attachment as { mime?: unknown; url?: unknown };
        if (typeof mime !== "string" || !mime.startsWith("image/")) continue;
        tokens +=
            typeof url === "string" && url.startsWith("data:")
                ? estimateImageTokensFromDataUrl(url)
                : IMAGE_FALLBACK_TOKENS;
    }
    return tokens;
}

function clampImageTokens(n: number): number {
    if (n < 1) return 1;
    if (n > IMAGE_TOKEN_CAP) return IMAGE_TOKEN_CAP;
    return n;
}

function base64Decode(b64: string): Uint8Array {
    // atob is available in Bun / Node 20+. Pad to multiple of 4.
    const pad = b64.length % 4;
    const padded = pad === 0 ? b64 : b64 + "=".repeat(4 - pad);
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

// PNG: bytes 0-7 = magic; IHDR starts at byte 8; width = 16..19, height = 20..23 (big-endian).
function parsePngDimensions(b: Uint8Array): { w: number; h: number } | null {
    if (b.length < 24) return null;
    if (
        b[0] !== 0x89 ||
        b[1] !== 0x50 ||
        b[2] !== 0x4e ||
        b[3] !== 0x47 ||
        b[4] !== 0x0d ||
        b[5] !== 0x0a ||
        b[6] !== 0x1a ||
        b[7] !== 0x0a
    )
        return null;
    const w = readUint32BE(b, 16);
    const h = readUint32BE(b, 20);
    if (!w || !h) return null;
    return { w, h };
}

// Random access into a base64 payload without decoding all of it. The first
// window is the 512-character preview already decoded by the caller; later
// windows are 4096 characters (3072 bytes) each and are decoded only when a
// read lands in them. Returns undefined past the end or for an undecodable
// window, which ends the JPEG scan and falls back to the fixed estimate.
const READER_PREVIEW_CHARS = 512;
const READER_PREVIEW_BYTES = 384;
const READER_WINDOW_CHARS = 4096;
const READER_WINDOW_BYTES = 3072;

function createBase64ByteReader(
    payload: string,
    preview: Uint8Array,
): (offset: number) => number | undefined {
    const windows = new Map<number, Uint8Array | null>();
    return (offset) => {
        if (offset < READER_PREVIEW_BYTES) return preview[offset];
        const index = Math.floor((offset - READER_PREVIEW_BYTES) / READER_WINDOW_BYTES);
        let window = windows.get(index);
        if (window === undefined) {
            const start = READER_PREVIEW_CHARS + index * READER_WINDOW_CHARS;
            const chars = payload.slice(start, start + READER_WINDOW_CHARS);
            try {
                window = chars.length > 0 ? base64Decode(chars) : null;
            } catch {
                window = null;
            }
            windows.set(index, window);
        }
        return window?.[offset - READER_PREVIEW_BYTES - index * READER_WINDOW_BYTES];
    };
}

// How far into the decoded JPEG the frame header is searched for. Each APPn
// segment is at most 64 KiB, and EXIF, XMP and ICC blocks rarely add up to more.
const JPEG_SCAN_LIMIT_BYTES = 256 * 1024;

// JPEG: scan for SOF markers (0xFFC0..0xFFC3, 0xFFC5..0xFFC7, 0xFFC9..0xFFCB, 0xFFCD..0xFFCF).
// After marker: length (2 bytes), precision (1 byte), height (2 bytes), width (2 bytes).
// Segments before the frame header (APP0 JFIF, APP1 EXIF, ...) are skipped by
// their declared length, so only the bytes at segment starts are decoded.
function parseJpegDimensions(
    byteAt: (offset: number) => number | undefined,
): { w: number; h: number } | null {
    if (byteAt(0) !== 0xff || byteAt(1) !== 0xd8 || byteAt(3) === undefined) return null;
    let i = 2;
    while (i < JPEG_SCAN_LIMIT_BYTES && byteAt(i + 8) !== undefined) {
        if (byteAt(i) !== 0xff) {
            i++;
            continue;
        }
        const marker = byteAt(i + 1);
        if (marker === undefined) break;
        if (isSofMarker(marker)) {
            // i+2: segment length (2B), i+4: precision (1B), i+5: height (2B), i+7: width (2B)
            const h = (byteAt(i + 5)! << 8) | byteAt(i + 6)!;
            const w = (byteAt(i + 7)! << 8) | byteAt(i + 8)!;
            if (w && h) return { w, h };
            return null;
        }
        // Skip over this segment. Marker has 2-byte length at i+2.
        if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) {
            i += 2;
            continue;
        }
        const segLen = (byteAt(i + 2)! << 8) | byteAt(i + 3)!;
        if (segLen < 2) return null;
        i += 2 + segLen;
    }
    return null;
}

function isSofMarker(m: number): boolean {
    if (m >= 0xc0 && m <= 0xc3) return true;
    if (m >= 0xc5 && m <= 0xc7) return true;
    if (m >= 0xc9 && m <= 0xcb) return true;
    if (m >= 0xcd && m <= 0xcf) return true;
    return false;
}

// WebP: "RIFF....WEBPVP8[ L|X| ]" — different chunk layouts per variant.
function parseWebpDimensions(b: Uint8Array): { w: number; h: number } | null {
    if (b.length < 30) return null;
    if (b[0] !== 0x52 || b[1] !== 0x49 || b[2] !== 0x46 || b[3] !== 0x46) return null; // RIFF
    if (b[8] !== 0x57 || b[9] !== 0x45 || b[10] !== 0x42 || b[11] !== 0x50) return null; // WEBP
    const variant = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
    if (variant === "VP8 ") {
        // Lossy: width/height at bytes 26-29 (14-bit each, little-endian).
        // The `& 0x3fff` already produces a non-negative 14-bit result; no
        // extra `|| 0` fallback is needed.
        const w = (b[26]! | (b[27]! << 8)) & 0x3fff;
        const h = (b[28]! | (b[29]! << 8)) & 0x3fff;
        if (w && h) return { w, h };
    } else if (variant === "VP8L") {
        // Lossless: 14-bit width/height starting byte 21
        const b0 = b[21]!;
        const b1 = b[22]!;
        const b2 = b[23]!;
        const b3 = b[24]!;
        const w = 1 + ((b0 | (b1 << 8)) & 0x3fff);
        const h = 1 + (((b1 >> 6) | (b2 << 2) | (b3 << 10)) & 0x3fff);
        if (w && h) return { w, h };
    } else if (variant === "VP8X") {
        // Extended: width-1 at 24..26 (24-bit LE), height-1 at 27..29 (24-bit LE)
        const w = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16));
        const h = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16));
        if (w && h) return { w, h };
    }
    return null;
}

// GIF: "GIF87a" or "GIF89a" then width (2B LE) + height (2B LE)
function parseGifDimensions(b: Uint8Array): { w: number; h: number } | null {
    if (b.length < 10) return null;
    if (b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return null;
    const w = b[6]! | (b[7]! << 8);
    const h = b[8]! | (b[9]! << 8);
    if (!w || !h) return null;
    return { w, h };
}

function readUint32BE(b: Uint8Array, offset: number): number {
    // `>>> 0` coerces to an unsigned 32-bit integer. Without it, a byte with
    // the MSB set produces a negative value (JS bitwise ops are 32-bit
    // signed), which would bypass downstream `< 1` guards and produce
    // wrong token counts for malformed/untrusted PNG headers.
    return (
        ((b[offset]! << 24) | (b[offset + 1]! << 16) | (b[offset + 2]! << 8) | b[offset + 3]!) >>> 0
    );
}
