use super::*;

pub(crate) struct SectionRequest<'a> {
    view: u64,
    slot: &'a str,
    section: usize,
    part: &'a str,
    offset: usize,
    max_bytes: usize,
}

impl<'a> SectionRequest<'a> {
    pub fn parse(params: &'a Value) -> Result<Self, Refusal> {
        let p = super::super::object(
            params,
            &[
                "session",
                "view",
                "slot",
                "section",
                "part",
                "offset",
                "max_bytes",
            ],
        )?;
        let number = |name: &str, default: Option<usize>| -> Result<usize, Refusal> {
            match p.get(name) {
                Some(value) => value
                    .as_u64()
                    .and_then(|n| usize::try_from(n).ok())
                    .ok_or_else(|| invalid(name)),
                None => default.ok_or_else(|| invalid(name)),
            }
        };
        let view = p
            .get("view")
            .and_then(Value::as_u64)
            .ok_or_else(|| invalid("view"))?;
        let slot = super::super::string(p, "slot")?;
        if !matches!(slot, "baseline" | "delta") {
            return Err(invalid("slot"));
        }
        let part = match p.get("part") {
            None => "text",
            Some(value) => value.as_str().ok_or_else(|| invalid("part"))?,
        };
        if !matches!(part, "text" | "image") {
            return Err(invalid("part"));
        }
        let max_bytes = number("max_bytes", Some(262_144))?;
        if !(1024..=262_144).contains(&max_bytes) {
            return Err(invalid("max_bytes"));
        }
        Ok(Self {
            view,
            slot,
            section: number("section", None)?,
            part,
            offset: number("offset", Some(0))?,
            max_bytes,
        })
    }
}

pub(crate) fn read_section(
    state: Option<&ReadState>,
    request: SectionRequest<'_>,
) -> Result<Value, Refusal> {
    let state = state.filter(|state| state.ready).ok_or_else(not_ready)?;
    let head = state
        .offered
        .as_ref()
        .or(state.confirmed.as_ref())
        .filter(|head| head.version == request.view)
        .ok_or_else(|| {
            error(
                "head_changed",
                "The session head changed. Read context.head again.",
            )
        })?;
    let slot = head
        .slots
        .iter()
        .find(|slot| {
            slot.id
                == if request.slot == "baseline" {
                    M0_ID
                } else {
                    M1_ID
                }
        })
        .ok_or_else(|| invalid("slot"))?;
    let sections = if slot.id == M1_ID && slot.text == M1_EMPTY {
        Vec::new()
    } else {
        split(&slot.text, slot.id == M1_ID)?
    };
    let (kind, text) = sections
        .get(request.section)
        .ok_or_else(|| invalid("section"))?;
    let image = request.part == "image";
    let data = if image {
        slot.image
            .as_ref()
            .filter(|_| *kind == "memory_mural")
            .map(|image| image.data.as_str())
            .ok_or_else(|| invalid("part"))?
    } else {
        text
    };
    if request.offset > data.len()
        || !data.is_char_boundary(request.offset)
        || image && !request.offset.is_multiple_of(4)
    {
        return Err(invalid("offset"));
    }
    let mut end = data
        .len()
        .min(request.offset.saturating_add(request.max_bytes));
    if image && end < data.len() {
        end -= (end - request.offset) % 4;
    }
    while !data.is_char_boundary(end) {
        end -= 1;
    }
    loop {
        let mut reply = json!({"view":request.view,"slot":request.slot,"section":request.section,"part":request.part,"offset":request.offset});
        reply[if image { "data" } else { "text" }] = json!(&data[request.offset..end]);
        if end < data.len() {
            reply["next_offset"] = json!(end);
        }
        // JSON escaping can expand text by six times. Bound the encoded frame
        // too, without changing the byte offsets used by subsequent chunks.
        if super::super::result_bytes(reply.clone()).len() <= REPLY_BUDGET {
            return Ok(reply);
        }
        end = request.offset + (end - request.offset) / 2;
        while !data.is_char_boundary(end) {
            end -= 1;
        }
    }
}
