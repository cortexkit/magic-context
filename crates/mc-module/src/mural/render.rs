//! Lay out and draw the memory mural, as the plugin's `render-mural.ts`. The
//! layout is deterministic: category banners, one bullet line per cue (two
//! short cues may share a line), word-wrapped to a column width chosen for the
//! cues, then split into one to three balanced columns. The smallest image
//! that fits every cue wins; when none does, the one that fits the most.
//!
//! The pixels match the plugin's for the same entries (the parity vectors in
//! `testdata/mural-vectors.json` check the layout text and a pixel checksum).
//! The PNG's compressed bytes may differ, since the two use different deflate
//! encoders; the layout text's checksum is what identifies a mural.

use super::font::{self, CELL_HEIGHT, CELL_WIDTH, LINE_PITCH};

/// The largest image, in pixels each way.
pub const MAX_SIDE: usize = 1_092;
/// Vision models bill images in 28-pixel tiles, so sides round up to them.
pub const VISION_TILE: usize = 28;
const COLUMNS: usize = 3;
const COLUMN_GAP: usize = 1;
/// Column width bounds, in characters: narrow enough to keep a sparse mural
/// compact, wide enough to stay readable.
const MIN_ROOM_WIDTH: usize = 40;
const MAX_ROOM_WIDTH: usize = 72;
/// Text rows per column.
const ROWS: usize = MAX_SIDE / LINE_PITCH;

const BODY_INK: [u8; 3] = [18, 20, 24];
const PROHIBITION_INK: [u8; 3] = [148, 28, 35];
const BANNER_INK: [u8; 3] = [255, 255, 255];
const OTHER_BANNER: [u8; 3] = [72, 78, 86];

fn banner_color(category: &str) -> [u8; 3] {
    match category {
        "PROJECT_RULES" => [24, 58, 112],
        "ARCHITECTURE" => [0, 88, 92],
        "CONSTRAINTS" => [126, 76, 16],
        "CONFIG_VALUES" => [88, 52, 132],
        "NAMING" => [28, 98, 58],
        _ => OTHER_BANNER,
    }
}

/// One memory's cue, in the order the mural shows them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub id: i64,
    pub category: String,
    pub importance: i32,
    pub cue: String,
}

/// A laid-out mural, before drawing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    room_width: usize,
    /// Each used column's rows; an empty row is blank.
    grid: Vec<Vec<String>>,
    column_count: usize,
    row_count: usize,
    /// The layout as text, one line per row with columns padded and joined:
    /// the mural's identity.
    pub text: String,
    /// The memories drawn, in layout order.
    pub rendered_ids: Vec<i64>,
    /// The memories that did not fit.
    pub dropped_ids: Vec<i64>,
    pub width: usize,
    pub height: usize,
}

/// JavaScript's `\s`, which the plugin's whitespace rules use.
fn is_js_space(character: char) -> bool {
    matches!(
        character,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn words(text: &str) -> impl Iterator<Item = &str> {
    text.split(is_js_space).filter(|word| !word.is_empty())
}

/// Runs of whitespace collapsed to one space, trimmed.
fn escape_text(text: &str) -> String {
    words(text).collect::<Vec<_>>().join(" ")
}

fn codepoints(text: &str) -> usize {
    text.chars().count()
}

fn banner(category: &str, room_width: usize) -> String {
    let label = format!(" <{category}> ");
    let length = codepoints(&label);
    if length > room_width {
        return label.chars().take(room_width).collect();
    }
    let remaining = room_width - length;
    format!(
        "{}{label}{}",
        "─".repeat(remaining / 2),
        "─".repeat(remaining.div_ceil(2))
    )
}

/// A token wider than the column, cut into column-width slices.
fn break_long_token(token: &str, width: usize) -> Vec<String> {
    let characters: Vec<char> = token.chars().collect();
    if characters.len() <= width {
        return vec![token.to_owned()];
    }
    characters
        .chunks(width)
        .map(|chunk| chunk.iter().collect())
        .collect()
}

/// One cue as bullet lines within `width`: the first line bulleted, the rest
/// indented two spaces.
fn wrap_cue(cue: &str, width: usize) -> Vec<String> {
    let indent = "  ";
    let cue = escape_text(cue);
    let pieces: Vec<String> = words(&cue)
        .flat_map(|word| break_long_token(word, width.saturating_sub(indent.len()).max(1)))
        .collect();
    if pieces.is_empty() {
        return vec!["•".to_owned()];
    }
    let mut lines = Vec::new();
    let mut line = "•".to_owned();
    for word in pieces {
        let separator = if line == "•" { "" } else { " " };
        let candidate = format!("{line}{separator}{word}");
        if codepoints(&candidate) <= width {
            line = candidate;
            continue;
        }
        lines.push(line);
        line = format!("{indent}{word}");
    }
    lines.push(line);
    lines
}

fn can_share(cue: &str, next: &str, room_width: usize) -> bool {
    let short = (room_width - 4) / 2;
    !cue.contains('⊘')
        && !next.contains('⊘')
        && codepoints(cue) <= short
        && codepoints(next) <= short
        && codepoints(&format!("•{cue} • {next}")) <= room_width
}

/// Each line's length before wrapping, for choosing the column width.
fn natural_line_lengths(entries: &[Entry], room_width: usize) -> Vec<usize> {
    let mut lengths = Vec::new();
    let mut current: Option<&str> = None;
    let mut index = 0;
    while index < entries.len() {
        let entry = &entries[index];
        if current != Some(entry.category.as_str()) {
            current = Some(&entry.category);
            lengths.push(codepoints(&format!(" <{}> ", entry.category)));
        }
        let cue = escape_text(&entry.cue);
        let next = entries
            .get(index + 1)
            .filter(|next| next.category == entry.category);
        let next_cue = next.map(|next| escape_text(&next.cue)).unwrap_or_default();
        if next.is_some() && can_share(&cue, &next_cue, room_width) {
            lengths.push(codepoints(&format!("•{cue} • {next_cue}")));
            index += 1;
        } else {
            lengths.push(1 + codepoints(&cue));
        }
        index += 1;
    }
    lengths
}

/// The narrowest column width that leaves at most the longest 5% of lines
/// wrapped.
fn choose_room_width(entries: &[Entry]) -> usize {
    for width in MIN_ROOM_WIDTH..=MAX_ROOM_WIDTH {
        let lengths = natural_line_lengths(entries, width);
        let allowed = (lengths.len() as f64 * 0.05).ceil() as usize;
        if lengths.iter().filter(|length| **length > width).count() <= allowed {
            return width;
        }
    }
    MAX_ROOM_WIDTH
}

struct Line {
    text: String,
    /// The entries whose cue starts on this line (two for a shared line).
    entry_ids: Vec<i64>,
    is_banner: bool,
}

fn plan_lines(entries: &[Entry], room_width: usize) -> Vec<Line> {
    let mut lines = Vec::new();
    let mut current: Option<&str> = None;
    let mut index = 0;
    while index < entries.len() {
        let entry = &entries[index];
        if current != Some(entry.category.as_str()) {
            current = Some(&entry.category);
            lines.push(Line {
                text: banner(&entry.category, room_width),
                entry_ids: Vec::new(),
                is_banner: true,
            });
        }
        let cue = escape_text(&entry.cue);
        let next = entries
            .get(index + 1)
            .filter(|next| next.category == entry.category);
        let next_cue = next.map(|next| escape_text(&next.cue)).unwrap_or_default();
        if let Some(next) = next.filter(|_| can_share(&cue, &next_cue, room_width)) {
            lines.push(Line {
                text: format!("•{cue} • {next_cue}"),
                entry_ids: vec![entry.id, next.id],
                is_banner: false,
            });
            index += 2;
            continue;
        }
        for (wrapped_index, text) in wrap_cue(&cue, room_width).into_iter().enumerate() {
            lines.push(Line {
                text,
                entry_ids: if wrapped_index == 0 {
                    vec![entry.id]
                } else {
                    Vec::new()
                },
                is_banner: false,
            });
        }
        index += 1;
    }
    lines
}

/// Balanced runs of the plan per column, at most [`ROWS`] each, never ending
/// a column on a banner when a body line can follow it.
fn split_plan(plan: &[Line], column_count: usize) -> Vec<std::ops::Range<usize>> {
    let mut columns = vec![0..0; column_count];
    let mut offset = 0;
    for (column, range) in columns.iter_mut().enumerate() {
        if offset >= plan.len() {
            break;
        }
        let remaining_lines = plan.len() - offset;
        let remaining_columns = column_count - column;
        let mut take = ROWS.min(remaining_lines.div_ceil(remaining_columns));
        while offset + take < plan.len() && take < ROWS && plan[offset + take - 1].is_banner {
            take += 1;
        }
        // A banner in the column's last row would head nothing: leave it blank.
        if take == ROWS && plan[offset + take - 1].is_banner {
            take -= 1;
        }
        if take == 0 {
            break;
        }
        *range = offset..offset + take;
        offset += take;
    }
    columns
}

/// `text` padded with spaces to `width` UTF-16 units, as JavaScript's
/// `padEnd` does.
fn pad_end(text: &str, width: usize) -> String {
    let units = text.encode_utf16().count();
    format!("{text}{}", " ".repeat(width.saturating_sub(units)))
}

fn layout(entries: &[Entry], plan: &[Line], room_width: usize, column_count: usize) -> Plan {
    let mut grid = vec![vec![String::new(); ROWS]; column_count];
    let mut rendered_ids = Vec::new();
    let mut placed = std::collections::HashSet::new();
    for (column, range) in split_plan(plan, column_count).into_iter().enumerate() {
        for (row, line) in plan[range].iter().enumerate() {
            grid[column][row] = line.text.clone();
            for id in &line.entry_ids {
                if placed.insert(*id) {
                    rendered_ids.push(*id);
                }
            }
        }
    }
    let dropped_ids = entries
        .iter()
        .filter(|entry| !placed.contains(&entry.id))
        .map(|entry| entry.id)
        .collect();
    let used_columns = grid
        .iter()
        .rposition(|column| column.iter().any(|row| !row.is_empty()))
        .map_or(0, |last| last + 1);
    let row_count = grid
        .iter()
        .filter_map(|column| column.iter().rposition(|row| !row.is_empty()))
        .map(|last| last + 1)
        .max()
        .unwrap_or(0);
    grid.truncate(used_columns);
    let lines: Vec<String> = (0..row_count)
        .map(|row| {
            grid.iter()
                .map(|column| pad_end(&column[row], room_width))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect();
    Plan {
        room_width,
        grid,
        column_count: used_columns,
        row_count,
        text: format!("{}\n", lines.join("\n")),
        rendered_ids,
        dropped_ids,
        width: 0,
        height: 0,
    }
}

fn content_width(plan: &Plan) -> usize {
    if plan.column_count == 0 {
        return 0;
    }
    plan.column_count * plan.room_width * CELL_WIDTH
        + COLUMN_GAP * (plan.column_count - 1) * CELL_WIDTH
}

/// A content extent rounded up to whole vision tiles, within the maximum.
fn snap(content: usize, maximum: usize) -> usize {
    maximum.min(VISION_TILE.max(content.div_ceil(VISION_TILE) * VISION_TILE))
}

/// The vision tiles an image of this size costs.
pub fn tile_area(width: usize, height: usize) -> usize {
    width.div_ceil(VISION_TILE) * height.div_ceil(VISION_TILE)
}

/// Lay out `entries`, already in mural order.
pub fn plan(entries: &[Entry]) -> Plan {
    let room_width = choose_room_width(entries);
    let lines = plan_lines(entries, room_width);
    let candidates: Vec<(usize, Plan)> = (1..=COLUMNS)
        .map(|requested| {
            let mut candidate = layout(entries, &lines, room_width, requested);
            candidate.width = snap(content_width(&candidate), MAX_SIDE);
            candidate.height = snap(candidate.row_count * LINE_PITCH, MAX_SIDE);
            (requested, candidate)
        })
        .collect();
    // A smaller image must not win by leaving cues out: compare only the
    // layouts that fit everything, or, when none does, prefer the one that
    // fits the most.
    let fitting: Vec<&(usize, Plan)> = candidates
        .iter()
        .filter(|(_, candidate)| candidate.dropped_ids.is_empty())
        .collect();
    let none_fit = fitting.is_empty();
    let compare: Vec<&(usize, Plan)> = if none_fit {
        candidates.iter().collect()
    } else {
        fitting
    };
    let mut best = compare[0];
    for candidate in &compare {
        let (requested, plan) = candidate;
        let (best_requested, best_plan) = best;
        let better = if none_fit && plan.rendered_ids.len() != best_plan.rendered_ids.len() {
            plan.rendered_ids.len() > best_plan.rendered_ids.len()
        } else {
            let area = tile_area(plan.width, plan.height);
            let best_area = tile_area(best_plan.width, best_plan.height);
            if area != best_area {
                area < best_area
            } else {
                requested < best_requested
            }
        };
        if better {
            best = candidate;
        }
    }
    best.1.clone()
}

/// The first `<name>` in a banner line.
fn banner_category(text: &str) -> Option<&str> {
    let start = text.find('<')? + 1;
    let length = text[start..].find('>')?;
    (length > 0).then(|| &text[start..start + length])
}

fn draw_text(
    pixels: &mut [u8],
    width: usize,
    height: usize,
    x: i64,
    y: i64,
    text: &str,
    ink: [u8; 3],
) {
    for (index, character) in text.chars().enumerate() {
        let left = x + (index * CELL_WIDTH) as i64;
        for (row, pattern) in font::glyph(character).iter().enumerate() {
            for column in 0..CELL_WIDTH {
                if pattern & (1 << (CELL_WIDTH - column - 1)) == 0 {
                    continue;
                }
                let (px, py) = (left + column as i64, y + row as i64);
                if px < 0 || py < 0 || px as usize >= width || py as usize >= height {
                    continue;
                }
                let offset = (py as usize * width + px as usize) * 3;
                pixels[offset..offset + 3].copy_from_slice(&ink);
            }
        }
    }
}

/// Fill the `(x, y, w, h)` rectangle with `color`, clipped to the image.
fn fill_rect(
    pixels: &mut [u8],
    width: usize,
    height: usize,
    rect: (i64, i64, usize, usize),
    color: [u8; 3],
) {
    let (x, y, w, h) = rect;
    let (left, top) = (x.max(0) as usize, y.max(0) as usize);
    let right = ((x + w as i64).max(0) as usize).min(width);
    let bottom = ((y + h as i64).max(0) as usize).min(height);
    for py in top..bottom {
        for px in left..right {
            let offset = (py * width + px) * 3;
            pixels[offset..offset + 3].copy_from_slice(&color);
        }
    }
}

/// The mural's RGB pixels, row by row, on white.
pub fn raster(plan: &Plan) -> Vec<u8> {
    let (width, height) = (plan.width, plan.height);
    let mut pixels = vec![255u8; width * height * 3];
    let left = (width as i64 - content_width(plan) as i64).div_euclid(2);
    for (column, rows) in plan.grid.iter().enumerate() {
        let x = left + (column * (plan.room_width + COLUMN_GAP) * CELL_WIDTH) as i64;
        for (row, text) in rows.iter().take(plan.row_count).enumerate() {
            let y = (row * LINE_PITCH) as i64;
            let is_banner = text.contains('<') && text.contains('>');
            if is_banner {
                let color = banner_category(text).map_or(OTHER_BANNER, banner_color);
                fill_rect(
                    &mut pixels,
                    width,
                    height,
                    (x, y, plan.room_width * CELL_WIDTH, CELL_HEIGHT),
                    color,
                );
            }
            let ink = if is_banner {
                BANNER_INK
            } else if text.contains('⊘') {
                PROHIBITION_INK
            } else {
                BODY_INK
            };
            draw_text(&mut pixels, width, height, x, y, text, ink);
        }
    }
    pixels
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & (crc & 1).wrapping_neg());
        }
    }
    crc ^ 0xffff_ffff
}

fn chunk(output: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    output.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let start = output.len();
    output.extend_from_slice(kind);
    output.extend_from_slice(data);
    let crc = crc32(&output[start..]);
    output.extend_from_slice(&crc.to_be_bytes());
}

/// RGB pixels as a PNG: no filtering, zlib at its best compression.
pub fn encode_png(pixels: &[u8], width: usize, height: usize) -> Vec<u8> {
    let mut raw = Vec::with_capacity((width * 3 + 1) * height);
    for row in pixels.chunks(width * 3).take(height) {
        raw.push(0);
        raw.extend_from_slice(row);
    }
    let mut header = Vec::with_capacity(13);
    header.extend_from_slice(&(width as u32).to_be_bytes());
    header.extend_from_slice(&(height as u32).to_be_bytes());
    header.extend_from_slice(&[8, 2, 0, 0, 0]);
    let mut output = vec![137, 80, 78, 71, 13, 10, 26, 10];
    chunk(&mut output, b"IHDR", &header);
    chunk(
        &mut output,
        b"IDAT",
        &miniz_oxide::deflate::compress_to_vec_zlib(&raw, 9),
    );
    chunk(&mut output, b"IEND", &[]);
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[derive(serde::Deserialize)]
    struct Vector {
        name: String,
        entries: Vec<VectorEntry>,
        text: String,
        width: usize,
        height: usize,
        rendered_ids: Vec<i64>,
        dropped_ids: Vec<i64>,
        pixels_sha256: String,
    }

    #[derive(serde::Deserialize)]
    struct VectorEntry {
        id: i64,
        category: String,
        importance: i32,
        cue: String,
    }

    /// The plugin's renderer and this one lay out and draw the same murals.
    #[test]
    fn layouts_and_pixels_match_the_plugins() {
        let vectors: Vec<Vector> =
            serde_json::from_str(include_str!("../../testdata/mural-vectors.json")).unwrap();
        assert!(!vectors.is_empty());
        for vector in vectors {
            let entries: Vec<Entry> = vector
                .entries
                .into_iter()
                .map(|entry| Entry {
                    id: entry.id,
                    category: entry.category,
                    importance: entry.importance,
                    cue: entry.cue,
                })
                .collect();
            let plan = plan(&entries);
            assert_eq!(plan.text, vector.text, "{}: layout text", vector.name);
            assert_eq!(
                (plan.width, plan.height),
                (vector.width, vector.height),
                "{}",
                vector.name
            );
            assert_eq!(plan.rendered_ids, vector.rendered_ids, "{}", vector.name);
            assert_eq!(plan.dropped_ids, vector.dropped_ids, "{}", vector.name);
            let pixels = raster(&plan);
            let digest = format!("{:x}", Sha256::digest(&pixels));
            assert_eq!(digest, vector.pixels_sha256, "{}: pixels", vector.name);
        }
    }

    #[test]
    fn the_png_decodes_to_its_pixels() {
        let entries = vec![Entry {
            id: 1,
            category: "NAMING".into(),
            importance: 50,
            cue: "ck-mc → module".into(),
        }];
        let plan = plan(&entries);
        let pixels = raster(&plan);
        let png = encode_png(&pixels, plan.width, plan.height);
        assert_eq!(&png[..8], &[137, 80, 78, 71, 13, 10, 26, 10]);
        assert_eq!(&png[12..16], b"IHDR");
        // The IDAT payload inflates back to filter bytes plus the pixels.
        let idat_length = u32::from_be_bytes(png[33..37].try_into().unwrap()) as usize;
        assert_eq!(&png[37..41], b"IDAT");
        let raw = miniz_oxide::inflate::decompress_to_vec_zlib(&png[41..41 + idat_length]).unwrap();
        assert_eq!(raw.len(), (plan.width * 3 + 1) * plan.height);
        assert_eq!(&raw[1..1 + plan.width * 3], &pixels[..plan.width * 3]);
        // The known check value of CRC-32.
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
    }
}
