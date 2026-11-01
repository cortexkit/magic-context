const CHUNK_BYTES: usize = 768;
const ITEMS_PER_GROUP: usize = 64;
const MAX_STRUCTURED_PATH: usize = 64;

struct Span {
    key: String,
    start: usize,
    end: usize,
}
struct Layout<'a> {
    bytes: &'a [u8],
    spans: Vec<Span>,
}
impl Layout<'_> {
    fn white(byte: u8) -> bool {
        matches!(byte, b' ' | b'\t' | b'\n' | b'\r')
    }
    fn ws(&self, mut at: usize) -> usize {
        while self.bytes.get(at).is_some_and(|byte| Self::white(*byte)) {
            at += 1;
        }
        at
    }
    fn quoted(&self, start: usize) -> Option<usize> {
        let mut at = start + 1;
        while at < self.bytes.len() {
            if self.bytes[at] == b'"' {
                return Some(at + 1);
            }
            at += if self.bytes[at] == b'\\' { 2 } else { 1 };
        }
        None
    }
    fn atomic(&self, start: usize) -> Option<usize> {
        if self.bytes.get(start) == Some(&b'"') {
            return self.quoted(start);
        }
        if matches!(self.bytes.get(start), Some(b'{') | Some(b'[')) {
            let (mut at, mut depth) = (start, 0_usize);
            while at < self.bytes.len() {
                let byte = self.bytes[at];
                if byte == b'"' {
                    at = self.quoted(at)?;
                    continue;
                }
                if matches!(byte, b'{' | b'[') {
                    depth += 1;
                }
                if matches!(byte, b'}' | b']') {
                    depth -= 1;
                    if depth == 0 {
                        return Some(at + 1);
                    }
                }
                at += 1;
            }
            return None;
        }
        let mut at = start;
        while at < self.bytes.len()
            && !Self::white(self.bytes[at])
            && !matches!(self.bytes[at], b',' | b'}' | b']')
        {
            at += 1;
        }
        (at > start).then_some(at)
    }
    fn flush(&mut self, group: &mut Option<(Span, usize)>) {
        if let Some((span, _)) = group.take() {
            self.spans.push(span);
        }
    }
    fn node(&mut self, start: usize, value: usize, path: &str) -> Option<usize> {
        let opening = *self.bytes.get(value)?;
        if !matches!(opening, b'{' | b'[') || path.len() > MAX_STRUCTURED_PATH {
            let end = self.atomic(value)?;
            self.spans.push(Span {
                key: format!("{path}!"),
                start,
                end,
            });
            return Some(end);
        }
        self.spans.push(Span {
            key: format!("{path}!"),
            start,
            end: value + 1,
        });
        let closing = if opening == b'{' { b'}' } else { b']' };
        let (mut end, mut index) = (value + 1, 0_usize);
        let mut group: Option<(Span, usize)> = None;
        loop {
            let mut at = self.ws(end);
            if self.bytes.get(at) == Some(&closing) {
                self.flush(&mut group);
                self.spans.push(Span {
                    key: format!("{path}~"),
                    start: end,
                    end: at + 1,
                });
                return Some(at + 1);
            }
            let prefix = end;
            if index > 0 {
                if self.bytes.get(at) != Some(&b',') {
                    return None;
                }
                at = self.ws(at + 1);
            }
            if opening == b'{' {
                if self.bytes.get(at) != Some(&b'"') {
                    return None;
                }
                at = self.ws(self.quoted(at)?);
                if self.bytes.get(at) != Some(&b':') {
                    return None;
                }
                at = self.ws(at + 1);
            }
            if !matches!(self.bytes.get(at), Some(b'{') | Some(b'['))
                || path.len() + 9 > MAX_STRUCTURED_PATH
            {
                let next = self.atomic(at)?;
                let block = index / ITEMS_PER_GROUP;
                if group.as_ref().is_some_and(|(_, old)| *old != block) {
                    self.flush(&mut group);
                }
                if let Some((span, _)) = group.as_mut() {
                    span.end = next;
                } else {
                    group = Some((
                        Span {
                            key: format!("{path}.{index:08x}!"),
                            start: prefix,
                            end: next,
                        },
                        block,
                    ));
                }
                end = next;
            } else {
                self.flush(&mut group);
                end = self.node(prefix, at, &format!("{path}.{index:08x}"))?;
            }
            index += 1;
        }
    }
}

/// The TypeScript layout's member-anchored paths preserve untouched namespaces after an append.
/// Spans cover raw input bytes, so duplicate keys, whitespace and opaque values remain lossless.
pub(super) fn layout_session_meta_bytes(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    if bytes.is_empty() {
        return Vec::new();
    }
    let mut layout = Layout {
        bytes,
        spans: Vec::new(),
    };
    let start = layout.ws(0);
    let end = layout.node(0, start, "0");
    let mut valid = end.is_some_and(|end| layout.ws(end) == bytes.len());
    if valid {
        if let Some(last) = layout.spans.last_mut() {
            last.end = bytes.len();
        }
        let (mut cursor, mut previous) = (0, String::new());
        for span in &layout.spans {
            if span.start != cursor || span.end <= span.start || span.key <= previous {
                valid = false;
                break;
            }
            cursor = span.end;
            previous = span.key.clone();
        }
        valid &= cursor == bytes.len();
    }
    if !valid {
        layout.spans.clear();
        layout.spans.push(Span {
            key: "0!".into(),
            start: 0,
            end: bytes.len(),
        });
    }
    let mut chunks = Vec::new();
    for span in layout.spans {
        for (index, body) in bytes[span.start..span.end].chunks(CHUNK_BYTES).enumerate() {
            chunks.push((format!("{}{:08x}", span.key, index), body.to_vec()));
        }
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn layouts_preserve_raw_bytes_including_opaque_and_deep_values() {
        let deep = format!("{}0{}", "[".repeat(100), "]".repeat(100));
        for raw in [
            "",
            "not-json",
            " {\"dup\":1,\"dup\":1e400,\"unicode\":\"東京 🧠\"} \n",
            &deep,
        ] {
            let chunks = layout_session_meta_bytes(raw.as_bytes());
            assert!(chunks.windows(2).all(|pair| pair[0].0 < pair[1].0));
            assert!(chunks.iter().all(|(_, body)| body.len() <= CHUNK_BYTES));
            assert_eq!(
                chunks
                    .into_iter()
                    .flat_map(|(_, body)| body)
                    .collect::<Vec<_>>(),
                raw.as_bytes()
            );
        }
    }
}
