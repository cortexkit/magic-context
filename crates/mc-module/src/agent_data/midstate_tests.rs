//! SHA-256 resumed from the running state Engram's session door reports,
//! checked against one-shot hashes of the same bytes.

use sha2::{Digest, Sha256};

use super::midstate::{Midstate, Resumed};

fn bytes(length: usize) -> Vec<u8> {
    (0..length).map(|i| (i * 31 + 7) as u8).collect()
}

fn one_shot(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Every split of a message into hashed-before-the-floor and
/// hashed-after-resuming gives the plain SHA-256 of the whole message. The
/// lengths cover a floor of 0 and the tails that matter to SHA-256's
/// padding: none, one byte, 55 (the last that leaves room for the length
/// in the same block), 56 (the first that does not), 63, and a block and
/// one byte past a block boundary; the same lengths again for the bytes
/// fed after resuming.
#[test]
fn a_hash_resumed_from_its_running_state_equals_the_one_shot_hash() {
    let lengths = [0, 1, 55, 56, 63, 64, 65];
    for floor in lengths.iter().copied().chain([64 + 55, 128 + 63, 1000]) {
        for rest in lengths.iter().copied().chain([200]) {
            let all = bytes(floor + rest);
            let mut before = Resumed::default();
            before.update(&all[..floor]);
            let midstate = before.midstate();
            assert_eq!(midstate.tail.len() / 2, floor % 64, "floor {floor}");
            let mut resumed = Resumed::from_midstate(&midstate, floor as u64).unwrap();
            resumed.update(&all[floor..]);
            assert_eq!(
                resumed.finish(),
                one_shot(&all),
                "floor {floor}, then {rest} bytes"
            );
        }
    }
}

/// Bytes fed in pieces of any size hash as when fed at once.
#[test]
fn bytes_fed_in_pieces_hash_as_when_fed_at_once() {
    let all = bytes(1000);
    for piece in [1, 7, 63, 64, 65, 333] {
        let mut hash = Resumed::default();
        for chunk in all.chunks(piece) {
            hash.update(chunk);
        }
        assert_eq!(hash.finish(), one_shot(&all), "pieces of {piece}");
    }
}

/// The state of an untrimmed stream is SHA-256's initial chaining value,
/// as eight big-endian words in hex, with an empty tail. Resumed from it,
/// the hash is the plain SHA-256 (here the standard "abc" vector).
#[test]
fn the_fresh_state_is_sha256s_initial_value() {
    let fresh = Midstate {
        chaining: "6a09e667bb67ae853c6ef372a54ff53a510e527f9b05688c1f83d9ab5be0cd19".into(),
        tail: String::new(),
    };
    assert_eq!(Resumed::default().midstate(), fresh);
    let mut hash = Resumed::from_midstate(&fresh, 0).unwrap();
    hash.update(b"abc");
    assert_eq!(
        hash.finish(),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

/// A state that does not describe `floor` bytes is refused: a tail of
/// another length than the floor leaves, a short chaining value, or hex
/// that is not hex.
#[test]
fn a_state_that_does_not_fit_its_floor_is_refused() {
    let state = |tail: &str| Midstate {
        chaining: "6a09e667bb67ae853c6ef372a54ff53a510e527f9b05688c1f83d9ab5be0cd19".into(),
        tail: tail.into(),
    };
    assert!(Resumed::from_midstate(&state(""), 64).is_ok());
    assert!(Resumed::from_midstate(&state("00"), 65).is_ok());
    assert!(Resumed::from_midstate(&state(""), 65).is_err());
    assert!(Resumed::from_midstate(&state("00"), 64).is_err());
    assert!(Resumed::from_midstate(&state("zz"), 65).is_err());
    let short = Midstate {
        chaining: "6a09e667".into(),
        tail: String::new(),
    };
    assert!(Resumed::from_midstate(&short, 0).is_err());
}
