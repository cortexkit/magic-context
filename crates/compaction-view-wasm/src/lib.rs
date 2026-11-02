//! The compaction view library as a WebAssembly module, for runners written
//! in JavaScript (THALAMUS's OpenCode runner renders in a plugin).
//!
//! It exports one function, [`cv_call`], which takes a function name and a
//! JSON input and returns JSON: exactly `compaction_view::vectors::call`, so a
//! JavaScript runner computes the render plan, the rule check, reply
//! cleaning, tag numbering and every checksum with the same code a Rust runner
//! and the compaction provider use. `js/index.mjs` wraps it for Bun and Node.
//!
//! The module has no imports. Memory crosses the boundary as byte buffers the
//! caller allocates with [`cv_alloc`] and releases with [`cv_free`]; the
//! answer is a buffer this module allocates, which the caller reads and then
//! releases with [`cv_free`].

use std::alloc::{alloc, dealloc, Layout};

/// Allocate `len` bytes for the caller to write an argument into. Returns
/// null for a zero length.
#[no_mangle]
pub extern "C" fn cv_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    let layout = Layout::array::<u8>(len).expect("argument too large");
    // SAFETY: `layout` has a non-zero size.
    unsafe { alloc(layout) }
}

/// Release a buffer [`cv_alloc`] or [`cv_call`] returned, with its length.
///
/// # Safety
///
/// `ptr` must come from this module with exactly `len`, and be released once.
#[no_mangle]
pub unsafe extern "C" fn cv_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    let layout = Layout::array::<u8>(len).expect("buffer too large");
    // SAFETY: the caller passes a buffer this module allocated with this
    // layout, once.
    unsafe { dealloc(ptr, layout) }
}

/// Call a library function. `function` and `input` are UTF-8 buffers the
/// caller wrote (the function name, and its input as JSON). Returns the
/// answer's address in the high 32 bits and its length in the low 32 bits,
/// which holds on wasm32, where addresses are 32 bits. The answer is JSON:
/// `{"ok": …}`, `{"refused": …}` or `{"error": …}`.
///
/// # Safety
///
/// Both buffers must be valid for their lengths. The caller keeps ownership
/// of them and must release the answer with [`cv_free`].
#[no_mangle]
pub unsafe extern "C" fn cv_call(
    function: *const u8,
    function_len: usize,
    input: *const u8,
    input_len: usize,
) -> u64 {
    // SAFETY: the caller guarantees both buffers are valid for their lengths.
    let (function, input) = unsafe {
        (
            std::slice::from_raw_parts(function, function_len),
            std::slice::from_raw_parts(input, input_len),
        )
    };
    let answer = call_bytes(function, input);
    let len = answer.len();
    let ptr = cv_alloc(len);
    if !ptr.is_null() {
        // SAFETY: `ptr` was just allocated for `len` bytes.
        unsafe { std::ptr::copy_nonoverlapping(answer.as_ptr(), ptr, len) };
    }
    ((ptr as usize as u64) << 32) | len as u64
}

/// [`cv_call`] on byte slices: the safe part, shared with the tests.
pub fn call_bytes(function: &[u8], input: &[u8]) -> Vec<u8> {
    let answer = match (
        std::str::from_utf8(function),
        serde_json::from_slice::<serde_json::Value>(input),
    ) {
        (Ok(function), Ok(input)) => compaction_view::vectors::call(function, input),
        (Err(_), _) => serde_json::json!({ "error": "the function name is not UTF-8" }),
        (_, Err(error)) => {
            serde_json::json!({ "error": format!("the input is not JSON: {error}") })
        }
    };
    serde_json::to_vec(&answer).expect("answers serialize")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_vector_gives_its_output_through_the_byte_interface() {
        let file = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../compaction-view/vectors/cases.json"
        ))
        .unwrap();
        let vectors: Vec<compaction_view::vectors::Vector> = serde_json::from_str(&file).unwrap();
        for vector in vectors {
            let input = serde_json::to_vec(&vector.input).unwrap();
            let answer: serde_json::Value =
                serde_json::from_slice(&call_bytes(vector.function.as_bytes(), &input)).unwrap();
            assert_eq!(answer, vector.output, "{}", vector.name);
        }
    }

    #[test]
    fn malformed_input_is_an_error_not_a_crash() {
        let answer: serde_json::Value =
            serde_json::from_slice(&call_bytes(b"plan", b"{not json")).unwrap();
        assert!(answer["error"].is_string());
        let answer: serde_json::Value =
            serde_json::from_slice(&call_bytes(b"nope", b"{}")).unwrap();
        assert!(answer["error"].is_string());
    }
}
