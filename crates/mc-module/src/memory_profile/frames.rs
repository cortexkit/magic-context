//! Magic Context's own prompt texts, the MC frames: output contracts, input
//! renderings and the other texts the `mc/memory-profile@1` schema keeps out of
//! profiles, so that no profile can change what the module's parsers read.
//! A profile places one with a section `{ "mc": name }` or a line that is
//! exactly `⟦mc:name⟧`. Each text lives in `crates/mc-module/frames/<name>.md`
//! and ends with one newline that is not part of the text.
//!
//! The frames carry the texts Magic Context sends today. A frame may hold
//! `⟦profile:…⟧` markers and `⟦if …⟧` lines, which the renderer expands from
//! the resolved profile, and runtime markers (`⟦name⟧`) its caller fills.

macro_rules! frame {
    ($name:literal) => {
        ($name, include_str!(concat!("../../frames/", $name, ".md")))
    };
}

/// Every MC frame, by name. A package cannot add a name.
pub(crate) const FRAMES: &[(&str, &str)] = &[
    frame!("dreamer/agent-registration.system"),
    frame!("dreamer/classify-memories.input"),
    frame!("dreamer/classify-memories.output-contract"),
    frame!("dreamer/compress-cues.input"),
    frame!("dreamer/compress-cues.output-contract"),
    frame!("dreamer/curate.input"),
    frame!("dreamer/curate.output-contract"),
    frame!("dreamer/lift-workspace.input"),
    frame!("dreamer/lift-workspace.output-contract"),
    frame!("dreamer/maintain-docs.input"),
    frame!("dreamer/maintain-docs.output-contract"),
    frame!("dreamer/map-memories.input"),
    frame!("dreamer/map-memories.output-contract"),
    frame!("dreamer/reflect-events.gate.input"),
    frame!("dreamer/reflect-events.gate.output-contract"),
    frame!("dreamer/reflect-events.input"),
    frame!("dreamer/reflect-events.output-contract"),
    frame!("dreamer/refresh-primers.input.closed-book"),
    frame!("dreamer/refresh-primers.input.raw"),
    frame!("dreamer/refresh-primers.output-contract"),
    frame!("dreamer/review-user-memories.input"),
    frame!("dreamer/review-user-memories.output-contract"),
    frame!("dreamer/review-user-memories.safety-rules"),
    frame!("dreamer/verify.input"),
    frame!("dreamer/verify.input.with-diff"),
    frame!("dreamer/verify.output-contract"),
    frame!("historian/input-notation"),
    frame!("historian/output-contract"),
    frame!("historian/turn-one.anchor-format"),
    frame!("historian/turn-one.fact-anchors"),
    frame!("historian/turn-one.reference-blocks"),
    frame!("historian/turn-one.user.two-pass"),
    frame!("historian/turn-two.check.compatibility.system"),
    frame!("historian/turn-two.check.compatibility.user"),
    frame!("historian/turn-two.check.disproof.system"),
    frame!("historian/turn-two.check.kept-clause.system"),
    frame!("historian/turn-two.check.support.system"),
    frame!("historian/turn-two.check.user"),
    frame!("historian/turn-two.decisions"),
    frame!("historian/turn-two.decisions.workspace"),
    frame!("historian/turn-two.user"),
    frame!("main-agent/ctx_memory.description.full"),
    frame!("main-agent/ctx_memory.description.light"),
    frame!("main-agent/ctx_memory_list.description"),
];

/// The full name of the frame `name` refers to in `frames`: the name itself,
/// or, for a name without a `/`, the one frame whose last path segment it is
/// (dreamer prompts write `⟦mc:verify.input⟧` for `dreamer/verify.input`).
pub(crate) fn resolve<'a, 'b>(
    frames: &'a [(&'b str, &'b str)],
    name: &str,
) -> Option<&'a (&'b str, &'b str)> {
    if name.contains('/') {
        return frames.iter().find(|(full, _)| *full == name);
    }
    let mut hits = frames
        .iter()
        .filter(|(full, _)| full.rsplit('/').next() == Some(name));
    match (hits.next(), hits.next()) {
        (Some(hit), None) => Some(hit),
        _ => None,
    }
}
