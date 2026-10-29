//! Frames compiled from checksum-pinned `testdata/memory_profile/mc-frames/`.
//! Runtime persona tiers and fragment files cannot override this registry.

use super::{refuse, Result};

const FRAMES: &[(&str, &str)] = &[
    ("dreamer/classify-memories.input", include_str!("../../testdata/memory_profile/mc-frames/dreamer/classify-memories.input.md")),
    ("dreamer/classify-memories.output-contract", include_str!("../../testdata/memory_profile/mc-frames/dreamer/classify-memories.output-contract.md")),
    ("dreamer/compress-cues.input", include_str!("../../testdata/memory_profile/mc-frames/dreamer/compress-cues.input.md")),
    ("dreamer/compress-cues.output-contract", include_str!("../../testdata/memory_profile/mc-frames/dreamer/compress-cues.output-contract.md")),
    ("dreamer/curate.input", include_str!("../../testdata/memory_profile/mc-frames/dreamer/curate.input.md")),
    ("dreamer/curate.memory-operations", include_str!("../../testdata/memory_profile/mc-frames/dreamer/curate.memory-operations.md")),
    ("dreamer/maintain-docs.input", include_str!("../../testdata/memory_profile/mc-frames/dreamer/maintain-docs.input.md")),
    ("dreamer/maintain-docs.output-contract", include_str!("../../testdata/memory_profile/mc-frames/dreamer/maintain-docs.output-contract.md")),
    ("dreamer/map-memories.input", include_str!("../../testdata/memory_profile/mc-frames/dreamer/map-memories.input.md")),
    ("dreamer/map-memories.output-contract", include_str!("../../testdata/memory_profile/mc-frames/dreamer/map-memories.output-contract.md")),
    ("dreamer/reflect-events.gate.input", include_str!("../../testdata/memory_profile/mc-frames/dreamer/reflect-events.gate.input.md")),
    ("dreamer/reflect-events.gate.output-contract", include_str!("../../testdata/memory_profile/mc-frames/dreamer/reflect-events.gate.output-contract.md")),
    ("dreamer/reflect-events.input", include_str!("../../testdata/memory_profile/mc-frames/dreamer/reflect-events.input.md")),
    ("dreamer/reflect-events.output-contract", include_str!("../../testdata/memory_profile/mc-frames/dreamer/reflect-events.output-contract.md")),
    ("dreamer/refresh-primers.input.closed-book", include_str!("../../testdata/memory_profile/mc-frames/dreamer/refresh-primers.input.closed-book.md")),
    ("dreamer/refresh-primers.input.raw", include_str!("../../testdata/memory_profile/mc-frames/dreamer/refresh-primers.input.raw.md")),
    ("dreamer/refresh-primers.output-contract", include_str!("../../testdata/memory_profile/mc-frames/dreamer/refresh-primers.output-contract.md")),
    ("dreamer/review-user-memories.input", include_str!("../../testdata/memory_profile/mc-frames/dreamer/review-user-memories.input.md")),
    ("dreamer/review-user-memories.output-contract", include_str!("../../testdata/memory_profile/mc-frames/dreamer/review-user-memories.output-contract.md")),
    ("dreamer/review-user-memories.safety-rules", include_str!("../../testdata/memory_profile/mc-frames/dreamer/review-user-memories.safety-rules.md")),
    ("dreamer/verify.input", include_str!("../../testdata/memory_profile/mc-frames/dreamer/verify.input.md")),
    ("dreamer/verify.input.with-diff", include_str!("../../testdata/memory_profile/mc-frames/dreamer/verify.input.with-diff.md")),
    ("dreamer/verify.output-contract", include_str!("../../testdata/memory_profile/mc-frames/dreamer/verify.output-contract.md")),
    ("historian/input-notation", include_str!("../../testdata/memory_profile/mc-frames/historian/input-notation.md")),
    ("historian/output-contract.combined", include_str!("../../testdata/memory_profile/mc-frames/historian/output-contract.combined.md")),
    ("historian/output-contract.xml", include_str!("../../testdata/memory_profile/mc-frames/historian/output-contract.xml.md")),
    ("main-agent/ctx_memory.description.full", include_str!("../../testdata/memory_profile/mc-frames/main-agent/ctx_memory.description.full.md")),
    ("main-agent/ctx_memory.description.light", include_str!("../../testdata/memory_profile/mc-frames/main-agent/ctx_memory.description.light.md")),
];

/// Qualified names prefer `name.variant` and fall back to `name` in `FRAMES`.
/// Bare names must match exactly one final path component. These are the lookup
/// rules of the profile artifact's `resolved-swe/resolve.ts::frameFile`.
pub(crate) fn frame(name: &str, variant: Option<&str>) -> Result<&'static str> {
    if name.contains('/') {
        if let Some(variant) = variant {
            let qualified = format!("{name}.{variant}");
            if let Some((_, text)) = FRAMES.iter().find(|(id, _)| *id == qualified) {
                return source(text);
            }
        }
        if let Some((_, text)) = FRAMES.iter().find(|(id, _)| *id == name) {
            return source(text);
        }
    } else {
        let hits: Vec<_> = FRAMES
            .iter()
            .filter(|(id, _)| id.rsplit('/').next() == Some(name))
            .collect();
        if hits.len() == 1 {
            return source(hits[0].1);
        }
    }
    Err(refuse(
        "prompt_invalid",
        format!("unknown or ambiguous MC frame {name}"),
    ))
}

pub(super) fn source(text: &str) -> Result<&str> {
    text.strip_suffix('\n')
        .ok_or_else(|| refuse("prompt_invalid", "prompt source must end in a newline"))
}
