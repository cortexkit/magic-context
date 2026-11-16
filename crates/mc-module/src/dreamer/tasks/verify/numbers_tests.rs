use super::*;

/// Each quantity `text` states, as its raw text, value and kind.
fn read(text: &str) -> Vec<(String, f64, Dim)> {
    quantities(text)
        .into_iter()
        .map(|quantity| (quantity.raw, quantity.value, quantity.dim))
        .collect()
}

fn one(text: &str) -> (f64, Dim) {
    let found = read(text);
    assert_eq!(found.len(), 1, "{text}: {found:?}");
    (found[0].1, found[0].2)
}

fn quantity(text: &str) -> Quantity {
    let mut found = quantities(text);
    assert_eq!(found.len(), 1, "{text}: {found:?}");
    found.remove(0)
}

#[test]
fn separators_and_count_suffixes_give_the_same_number() {
    for text in [
        "64_000",
        "64,000",
        "64000",
        "64k tokens",
        "64K",
        "a cap of 64k.",
    ] {
        assert_eq!(one(text), (64_000.0, Dim::Count), "{text}");
    }
    assert_eq!(one("1.5M rows"), (1_500_000.0, Dim::Count));
    assert_eq!(one("2M"), (2_000_000.0, Dim::Count));
    assert_eq!(one("1e6"), (1_000_000.0, Dim::Count));
    // A Rust literal's type is no unit.
    assert_eq!(one("let cap = 15_000u64;"), (15_000.0, Dim::Count));
    assert_eq!(one("0.05_f64"), (0.05, Dim::Count));
    // A list of numbers is each number.
    assert_eq!(
        read("1,2,3")
            .iter()
            .map(|(_, value, _)| *value)
            .collect::<Vec<_>>(),
        [1.0, 2.0, 3.0]
    );
}

#[test]
fn percents_times_and_sizes_are_read_in_base_units() {
    assert_eq!(one("5%"), (0.05, Dim::Percent));
    assert_eq!(one("at 95 %"), (0.95, Dim::Percent));
    for (text, ms) in [
        ("500ms", 500.0),
        ("15 s", 15_000.0),
        ("15s", 15_000.0),
        ("30 sec", 30_000.0),
        ("30 seconds", 30_000.0),
        ("5 min", 300_000.0),
        ("5-minute", 300_000.0),
        ("5 minutes", 300_000.0),
        ("1 h", 3_600_000.0),
        ("2 hours", 7_200_000.0),
        ("1 hour", 3_600_000.0),
        ("3 days", 259_200_000.0),
        ("1 day", 86_400_000.0),
    ] {
        assert_eq!(one(text), (ms, Dim::Time), "{text}");
    }
    for (text, bytes) in [
        ("21-byte header", 21.0),
        ("21 bytes", 21.0),
        ("64 KB", 64_000.0),
        ("64 KiB", 65_536.0),
        ("1 MiB", 1_048_576.0),
        ("64MiB", 67_108_864.0),
        ("2 GB", 2e9),
        ("1 GiB", 1_073_741_824.0),
    ] {
        assert_eq!(one(text), (bytes, Dim::Bytes), "{text}");
    }
    // A word that is no unit leaves a count.
    assert_eq!(one("5 sessions"), (5.0, Dim::Count));
    assert_eq!(one("10 attempts"), (10.0, Dim::Count));
}

#[test]
fn dates_versions_references_ids_and_names_are_not_quantities() {
    for text in [
        "on 2026-11-16 at 12:58-13:26Z",
        "16 Nov",
        "Nov 16, 2026",
        "since 9am",
        "0.49.55 adds it",
        "since 0.49",
        "the 0.50 line",
        "0.49's verify",
        "Opus 5.5 and Sonnet 5.5",
        "issue #123 and §2",
        "Mode 3",
        "row 12, step 2, invariant 4",
        "task.rs:12",
        "commit 7fca5ac695 and 2fa5f24c",
        "u64 and sha256",
        "MC-D12",
        "m[0] and m[1]",
        "crates/v2/x.rs and samples_v18_tests.rs",
        "the 1st and 2nd",
        "3x",
        "0x40",
    ] {
        assert_eq!(read(text), [], "{text}");
    }
}

#[test]
fn equal_forms_are_the_same_number() {
    let same_as = |left: &str, right: &str| same(&quantity(left), &quantity(right));
    // Time in any unit.
    assert!(same_as("15 s", "15_000"));
    assert!(same_as("15 s", "15"));
    assert!(same_as("15 s", "15000 ms"));
    assert!(same_as("1 h", "3_600_000"));
    assert!(same_as("1 h", "60 min"));
    assert!(!same_as("15 s", "16"));
    // A percent as itself or as its fraction.
    assert!(same_as("5%", "0.05"));
    assert!(same_as("5%", "5"));
    assert!(same_as("0.05", "5%"));
    assert!(!same_as("5%", "0.5"));
    // A size in any unit.
    assert!(same_as("64 MiB", "67108864"));
    assert!(same_as("64 MiB", "64"));
    assert!(same_as("2 GB", "2_000_000_000"));
    // Counts.
    assert!(same_as("64k", "64_000"));
    assert!(same_as("64,000", "64000"));
    assert!(!same_as("64k", "64"));
}

#[test]
fn a_derive_holds_when_its_arithmetic_does() {
    let steps = derivations("150 s = 10 × 15_000 ms").unwrap();
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].result.value, 150_000.0);
    assert_eq!(
        steps[0]
            .inputs
            .iter()
            .map(|input| (input.raw.as_str(), input.value, input.dim))
            .collect::<Vec<_>>(),
        [("10", 10.0, Dim::Count), ("15_000 ms", 15_000.0, Dim::Time)]
    );
    for holds in [
        "150 s = 10 * 15",
        "1 h = 60 × 60 × 1000 ms",
        "64 MiB = 64 × 1024 × 1024",
        "3_200 = 5% × 64k",
        "90 s = (1 + 2) × 30 s",
        "2 min = 240 s / 2",
        "45 s = 60 s - 15 s",
        "150 s = 10 × 15_000 ms; 64k = 64 × 1000",
    ] {
        assert!(
            derivations(holds).is_ok(),
            "{holds}: {:?}",
            derivations(holds)
        );
    }
}

#[test]
fn a_derive_that_does_not_hold_or_cannot_be_read_is_refused() {
    let wrong = derivations("150 s = 10 × 10 s").unwrap_err();
    assert!(wrong.contains("does not hold"), "{wrong}");
    for unreadable in [
        "150 s",
        "= 10",
        "150 s = 10 ×",
        "150 s = (10",
        "150 s = 10 / 0",
        "150 s = ten times",
        "",
    ] {
        assert!(derivations(unreadable).is_err(), "{unreadable}");
    }
    let two_numbers = derivations("150 s 2 = 300 s").unwrap_err();
    assert!(two_numbers.contains("not one number"), "{two_numbers}");
}
