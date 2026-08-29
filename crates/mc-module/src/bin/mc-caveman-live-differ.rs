//! Privacy-preserving caveman oracle used by the parity differ's live mode.
//!
//! Source text arrives on stdin and never appears on stdout. The response contains
//! only source/output hashes and UTF-8 byte lengths, so live message content is not
//! copied into an audit artifact.

#[path = "../caveman.rs"]
mod caveman;

use caveman::CavemanLevel;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{self, Read};

#[derive(Debug, Deserialize)]
struct Request {
    cases: Vec<InputCase>,
}

#[derive(Debug, Deserialize)]
struct InputCase {
    key: String,
    text: String,
}

#[derive(Debug, Serialize)]
struct Response {
    cases: Vec<OutputCase>,
}

#[derive(Debug, Serialize)]
struct OutputCase {
    key: String,
    source_sha256: String,
    source_bytes: usize,
    lite: Fingerprint,
    full: Fingerprint,
    ultra: Fingerprint,
}

#[derive(Debug, Serialize)]
struct Fingerprint {
    sha256: String,
    bytes: usize,
}

fn fingerprint(value: &str) -> Fingerprint {
    Fingerprint {
        sha256: format!("{:x}", Sha256::digest(value.as_bytes())),
        bytes: value.len(),
    }
}

fn main() {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .expect("read caveman live request from stdin");
    let request: Request = serde_json::from_str(&input).expect("valid caveman live request JSON");
    let cases = request
        .cases
        .into_iter()
        .map(|case| OutputCase {
            source_sha256: format!("{:x}", Sha256::digest(case.text.as_bytes())),
            source_bytes: case.text.len(),
            lite: fingerprint(&caveman::compress(&case.text, CavemanLevel::Lite)),
            full: fingerprint(&caveman::compress(&case.text, CavemanLevel::Full)),
            ultra: fingerprint(&caveman::compress(&case.text, CavemanLevel::Ultra)),
            key: case.key,
        })
        .collect();
    serde_json::to_writer(io::stdout(), &Response { cases })
        .expect("write caveman live fingerprints");
}
