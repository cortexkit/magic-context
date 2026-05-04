// Image token estimation that matches Anthropic's vision billing formula.
//
// Anthropic vision docs: tokens ≈ (width × height) / 750
// https://docs.claude.com/en/build-with-claude/vision
//
// Images are sent inline as data URLs. Base64 char length is a terrible proxy
// (50x over-estimate for a typical screenshot), so we parse PNG/JPEG headers
// directly to read real pixel dimensions.

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
    const header = url.slice(0, comma);
    const payload = url.slice(comma + 1);

    // Only decode the first ~32 bytes of the image — enough for both PNG IHDR
    // (bytes 16-24) and JPEG SOF markers (typically within first 256 bytes).
    // Read up to ~512 bytes of base64 to cover edge-case JPEG marker offsets.
    const sliceLen = Math.min(512, payload.length);
    const preview = payload.slice(0, sliceLen);

    let bytes: Uint8Array;
    try {
        bytes = base64Decode(preview);
    } catch {
        return IMAGE_FALLBACK_TOKENS;
    }

    if (header.includes("image/png")) {
        const dims = parsePngDimensions(bytes);
        if (dims) return clampImageTokens(Math.ceil((dims.w * dims.h) / IMAGE_TOKEN_DIVISOR));
    } else if (header.includes("image/jpeg") || header.includes("image/jpg")) {
        const dims = parseJpegDimensions(bytes);
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

// JPEG: scan for SOF markers (0xFFC0..0xFFC3, 0xFFC5..0xFFC7, 0xFFC9..0xFFCB, 0xFFCD..0xFFCF).
// After marker: length (2 bytes), precision (1 byte), height (2 bytes), width (2 bytes).
function parseJpegDimensions(b: Uint8Array): { w: number; h: number } | null {
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
    let i = 2;
    while (i < b.length - 8) {
        if (b[i] !== 0xff) {
            i++;
            continue;
        }
        const marker = b[i + 1];
        if (marker === undefined) break;
        if (isSofMarker(marker)) {
            // i+2: segment length (2B), i+4: precision (1B), i+5: height (2B), i+7: width (2B)
            const h = (b[i + 5]! << 8) | b[i + 6]!;
            const w = (b[i + 7]! << 8) | b[i + 8]!;
            if (w && h) return { w, h };
            return null;
        }
        // Skip over this segment. Marker has 2-byte length at i+2.
        if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) {
            i += 2;
            continue;
        }
        const segLen = (b[i + 2]! << 8) | b[i + 3]!;
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
