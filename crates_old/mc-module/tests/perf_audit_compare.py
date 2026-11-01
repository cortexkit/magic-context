"""Compare every profiled pass's complete wire and raw persisted-row digests.

Run with two different ck-mc profiling logs, or --self-test to test the comparator.
The logs contain only digests and non-private costs, never database row content.
"""

import argparse
import json
from pathlib import Path
import re
import unittest


def identities(lines):
    records = {}
    for line in lines:
        if not line.startswith("COST_IDENTITY "):
            continue
        record = json.loads(line.removeprefix("COST_IDENTITY "))
        key = (record["session"], record["mode"], record["pass"])
        if key in records:
            raise ValueError(f"duplicate pass: {key}")
        digests = tuple(
            record[field]
            for field in ("wire_sha256", "state_sha256", "context_sha256")
        )
        if not all(isinstance(digest, str) and re.fullmatch("[0-9a-f]{64}", digest) for digest in digests):
            raise ValueError(f"invalid SHA-256 digests: {key}")
        records[key] = digests
    if not records:
        raise ValueError("no COST_IDENTITY records; uninstrumented logs cannot prove parity")
    return records


def compare(before, after):
    if before.keys() != after.keys():
        raise ValueError("pass sets differ")
    for key, expected in before.items():
        actual = after[key]
        for label, left, right in zip(("wire", "store.db", "context.db"), expected, actual):
            if left != right:
                raise ValueError(f"{key}: {label} bytes differ")
    return len(before)


class ComparatorTests(unittest.TestCase):
    def setUp(self):
        self.key = ("fixture", "warm_delta", 3)
        self.before = {self.key: ("wire", "state", "context")}

    def test_equal_wire_and_both_stores_pass(self):
        self.assertEqual(compare(self.before, dict(self.before)), 1)

    def test_changed_wire_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "wire bytes differ"):
            compare(self.before, {self.key: ("changed", "state", "context")})

    def test_changed_store_state_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "store.db bytes differ"):
            compare(self.before, {self.key: ("wire", "changed", "context")})

    def test_changed_context_state_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "context.db bytes differ"):
            compare(self.before, {self.key: ("wire", "state", "changed")})

    def test_missing_pass_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "pass sets differ"):
            compare(self.before, {})

    def test_empty_log_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "no COST_IDENTITY"):
            identities(["COST_SAMPLE {}"])

    def test_duplicate_pass_is_rejected(self):
        record = {"session": "fixture", "mode": "warm_delta", "pass": 0}
        record.update(dict.fromkeys(("wire_sha256", "state_sha256", "context_sha256"), "0" * 64))
        line = "COST_IDENTITY " + json.dumps(record)
        with self.assertRaisesRegex(ValueError, "duplicate pass"):
            identities([line, line])

    def test_placeholder_digests_are_rejected(self):
        record = {"session": "fixture", "mode": "warm_delta", "pass": 0}
        record.update(dict.fromkeys(("wire_sha256", "state_sha256", "context_sha256"), "placeholder"))
        with self.assertRaisesRegex(ValueError, "invalid SHA-256"):
            identities(["COST_IDENTITY " + json.dumps(record)])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before", nargs="?", type=Path)
    parser.add_argument("after", nargs="?", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(ComparatorTests)
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        raise SystemExit(not result.wasSuccessful())
    if args.before is None or args.after is None:
        parser.error("two profiling logs are required")
    if args.before.samefile(args.after):
        parser.error("comparing a log to itself is not differential evidence")
    before = identities(args.before.read_text().splitlines())
    after = identities(args.after.read_text().splitlines())
    count = compare(before, after)
    sessions = {key[0] for key in before}
    for session in sessions:
        for mode in ("warm_delta", "warm_full", "evicted_full"):
            passes = [key[2] for key in before if key[:2] == (session, mode)]
            if len(passes) < 23:
                raise ValueError(f"{session}/{mode}: need three warmups and at least 20 samples")
    print(f"PASS: {count} complete wire/store/context comparisons across {len(sessions)} fixtures")


if __name__ == "__main__":
    main()
