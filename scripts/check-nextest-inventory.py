#!/usr/bin/env python3
"""Compare libtest discovery with the exact disjoint nextest archive partitions."""

import difflib
import json
from pathlib import Path
import sys
import unittest
import xml.etree.ElementTree as ET


def libtest_names(text):
    return sorted(line.removesuffix(": test") for line in text.splitlines() if line.endswith(": test"))


def nextest_names(document, selected_only=False, ignored_only=False):
    suites = document["rust-suites"]
    if len(suites) != 1:
        raise ValueError("expected exactly one mc-module lib binary")
    suite = next(iter(suites.values()))
    if suite["status"] != "listed":
        raise ValueError("lib binary was not listed")
    return sorted(
        name for name, case in suite["testcases"].items()
        if (not selected_only or case["filter-match"]["status"] == "matches")
        and (not ignored_only or case["ignored"])
    )


def assert_union(expected, partitions):
    union = sorted(name for partition in partitions for name in partition)
    if not expected or len(set(union)) != len(union) or union != expected:
        diff = "".join(difflib.unified_diff(
            [name + "\n" for name in expected], [name + "\n" for name in union],
            fromfile="cargo-libtest", tofile="nextest-partition-union"))
        raise ValueError("test inventory missing, duplicated or changed\n" + diff)
    return union


def assert_executed(expected, ignored, executed):
    runnable = sorted(set(expected) - set(ignored))
    if len(executed) != len(set(executed)) or sorted(executed) != runnable:
        raise ValueError("JUnit execution does not equal the selected non-ignored inventory")
    return len(runnable)


def check_junit(directory, label, path):
    expected = (directory / (label + "-names.txt")).read_text().splitlines()
    ignored = libtest_names((directory / "cargo-ignored.txt").read_text())
    executed = [case.attrib["name"] for case in ET.parse(path).iter("testcase")]
    count = assert_executed(expected, ignored, executed)
    print(f"PASS: {label} JUnit contains exactly {count} executed tests")


def check(directory):
    expected = libtest_names((directory / "cargo-list.txt").read_text())
    ignored = libtest_names((directory / "cargo-ignored.txt").read_text())
    all_tests = json.loads((directory / "all.json").read_text())
    if nextest_names(all_tests) != expected or nextest_names(all_tests, ignored_only=True) != ignored:
        raise ValueError("archive discovery or ignored-test policy differs from cargo libtest")
    partitions = []
    for label in ["lib-1", "lib-2", "lib-3", "lib-4"]:
        document = json.loads((directory / (label + ".json")).read_text())
        names = nextest_names(document, selected_only=True)
        if not names:
            raise ValueError("empty lib partition: " + label)
        partitions.append(names)
        (directory / (label + "-names.txt")).write_text("".join(name + "\n" for name in names))
        print(f"{label}: {len(names)} discovered ({sum(name in ignored for name in names)} ignored)")
    union = assert_union(expected, partitions)
    for label, names in [("cargo-names", expected), ("union-names", union)]:
        (directory / (label + ".txt")).write_text("".join(name + "\n" for name in names))
        print(f"--- {label} ({len(names)}) ---\n" + "\n".join(names))
    print(f"PASS: exact disjoint union of {len(expected)} names; {len(ignored)} remain ignored")


class InventoryTests(unittest.TestCase):
    def test_exact_union(self):
        self.assertEqual(assert_union(["a", "b", "c", "d"], [["b"], ["d"], ["a"], ["c"]]), ["a", "b", "c", "d"])
        self.assertEqual(assert_union(["a", "b"], [["b"], ["a"], []]), ["a", "b"])

    def test_missing_duplicate_and_empty_are_rejected(self):
        for expected, parts in [(["a", "b"], [["a"]]), (["a"], [["a"], ["a"]]), ([], [[]])]:
            with self.assertRaises(ValueError):
                assert_union(expected, parts)

    def test_libtest_parser(self):
        self.assertEqual(libtest_names("a::b: test\n2 tests, 0 benchmarks\nc: benchmark\n"), ["a::b"])

    def test_filters_and_ignored_policy(self):
        document = {"rust-suites": {"mc-module": {"status": "listed", "testcases": {
            "a": {"ignored": False, "filter-match": {"status": "matches"}},
            "b": {"ignored": True, "filter-match": {"status": "mismatch"}},
        }}}}
        self.assertEqual(nextest_names(document), ["a", "b"])
        self.assertEqual(nextest_names(document, selected_only=True), ["a"])
        self.assertEqual(nextest_names(document, ignored_only=True), ["b"])

    def test_executed_inventory(self):
        self.assertEqual(assert_executed(["a", "b"], ["b"], ["a"]), 1)
        self.assertEqual(assert_executed([], [], []), 0)
        for executed in [[], ["a", "a"], ["a", "b"], ["different"]]:
            with self.assertRaises(ValueError):
                assert_executed(["a", "b"], ["b"], executed)


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        unittest.main(argv=[sys.argv[0]], verbosity=2)
    elif len(sys.argv) == 2:
        check(Path(sys.argv[1]))
    elif len(sys.argv) == 5 and sys.argv[1] == "--junit":
        check_junit(Path(sys.argv[2]), sys.argv[3], Path(sys.argv[4]))
    else:
        sys.exit("usage: check-nextest-inventory.py DIRECTORY|--self-test|--junit DIRECTORY LABEL XML")
