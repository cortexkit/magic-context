//! Raw JSON array extraction for before/after wire identity, without Value normalization.

fn whitespace(bytes: &[u8], mut offset: usize) -> usize {
    while bytes.get(offset).is_some_and(u8::is_ascii_whitespace) {
        offset += 1;
    }
    offset
}

fn value_end(bytes: &[u8], start: usize) -> usize {
    let mut depth = 0usize;
    let mut quoted = false;
    let mut escaped = false;
    for (index, byte) in bytes.iter().copied().enumerate().skip(start) {
        if quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
                if depth == 0 {
                    return index + 1;
                }
            }
            continue;
        }
        match byte {
            b'"' => quoted = true,
            b'{' | b'[' => depth += 1,
            b'}' | b']' if depth > 0 => {
                depth -= 1;
                if depth == 0 {
                    return index + 1;
                }
            }
            b',' | b'}' | b']' if depth == 0 => return index,
            byte if byte.is_ascii_whitespace() && depth == 0 => return index,
            _ => {}
        }
    }
    bytes.len()
}

pub(super) fn field<'a>(bytes: &'a [u8], name: &str) -> &'a [u8] {
    let mut offset = whitespace(bytes, 0);
    assert_eq!(bytes[offset], b'{');
    offset += 1;
    loop {
        offset = whitespace(bytes, offset);
        assert_ne!(
            bytes[offset], b'}',
            "required JSON field is missing: {name}"
        );
        let key_end = value_end(bytes, offset);
        let key: String = serde_json::from_slice(&bytes[offset..key_end]).unwrap();
        offset = whitespace(bytes, key_end);
        assert_eq!(bytes[offset], b':');
        offset = whitespace(bytes, offset + 1);
        let end = value_end(bytes, offset);
        if key == name {
            return &bytes[offset..end];
        }
        offset = whitespace(bytes, end);
        assert_eq!(
            bytes[offset], b',',
            "required JSON field is missing: {name}"
        );
        offset += 1;
    }
}

pub(super) fn items(bytes: &[u8]) -> Vec<Vec<u8>> {
    let mut offset = whitespace(bytes, 0);
    assert_eq!(bytes[offset], b'[');
    offset += 1;
    let mut result = Vec::new();
    loop {
        offset = whitespace(bytes, offset);
        if bytes[offset] == b']' {
            return result;
        }
        let end = value_end(bytes, offset);
        result.push(bytes[offset..end].to_vec());
        offset = whitespace(bytes, end);
        if bytes[offset] != b']' {
            assert_eq!(bytes[offset], b',');
            offset += 1;
        }
    }
}

pub(super) fn output(response: &[u8], native: &[Vec<u8>]) -> Vec<u8> {
    let mut bytes = b"{\"ck\":".to_vec();
    bytes.extend_from_slice(field(response, "ck_messages"));
    bytes.extend_from_slice(b",\"native\":[");
    for (index, message) in native.iter().enumerate() {
        if index > 0 {
            bytes.push(b',');
        }
        bytes.extend_from_slice(message);
    }
    bytes.extend_from_slice(b"]}");
    bytes
}

#[test]
fn raw_profile_wire_retains_key_order_and_string_escape_bytes() {
    let before = br#"{"extra":{"nested":["a,]}\\\"",null]},"ck_messages":[{"z":1,"a":"\u0061"}],"native_messages":[{"b":true,"a":0}]}"#;
    let after = br#"{"ck_messages":[{"a":"a","z":1}],"native_messages":[{"a":0,"b":true}]}"#;
    let before_value: serde_json::Value = serde_json::from_slice(before).unwrap();
    let after_value: serde_json::Value = serde_json::from_slice(after).unwrap();
    assert_eq!(before_value["ck_messages"], after_value["ck_messages"]);
    assert_eq!(
        before_value["native_messages"],
        after_value["native_messages"]
    );
    let before_native = items(field(before, "native_messages"));
    let after_native = items(field(after, "native_messages"));
    assert_ne!(output(before, &before_native), output(after, &after_native));
    assert_eq!(items(b" [ ] "), Vec::<Vec<u8>>::new());
    assert_eq!(before_native, vec![br#"{"b":true,"a":0}"#.to_vec()]);
}
