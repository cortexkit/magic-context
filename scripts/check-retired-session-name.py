#!/usr/bin/env python3
"""Keep the former session name out of Magic Context's source and documentation."""

from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent.parent
SCOPE = ("crates", "scripts", "docs", "ARCHITECTURE.md", "STRUCTURE.md")
MODULE = "crates/mc-module/"
NAME = "mode"
RETIRED = re.compile(rb"mode[ -]?3", re.IGNORECASE)
OLD = f"{NAME}3"
NEWLINE = b"\n"


@dataclass(frozen=True)
class ExceptionRule:
    text: str
    max_uses: int
    reason: str


def allow_list():
    result = defaultdict(list)

    def allow(reason, text, *entries):
        for path, count in entries:
            result[path].append(ExceptionRule(text, count, reason))

    def module(reason, text, *entries):
        allow(reason, text, *((MODULE + path, count) for path, count in entries))

    allow("Placement must recognize, move, and test the previous development filename.",
          f"{OLD}.db", ("scripts/place-ck-mc.sh", 1), ("scripts/restart-window.sh", 1),
          ("scripts/place-ck-mc.test.py", 8))
    module("Startup refuses the previous filename and gives the exact recovery steps.",
           f"{OLD}.db", ("src/storage_paths.rs", 6), ("tests/startup.rs", 2))
    module("The content-addressed text reference is persisted in session state.",
           f'"{OLD}_text"', ("src/store_text.rs", 4))
    module("This storage golden includes the same persisted reference.",
           f'\\"{OLD}_text\\"', ("testdata/head-bytes-df3a14aa.json", 3))
    module("The 0.49 plugin and CLI read the persisted session move marker.",
           f"{OLD}_move:", ("src/move_in.rs", 1), ("src/rekey/rekey_tests.rs", 1),
           ("tests/broca_move_tests.rs", 4), ("tests/scenarios.rs", 2),
           ("tests/support/lifecycle_scenarios.rs", 2))
    module("Offline moves and agent installs resume from these persisted batch rows.",
           f"{OLD}_batch:", ("src/move_batches.rs", 1), ("src/move_in/lock_tests.rs", 1),
           ("src/move_in/writer_tests.rs", 1), ("src/agent_data/crash_tests.rs", 1),
           ("src/agent_data/install_lock_tests.rs", 1))
    module("Offline moves use the persisted renumber record to resume without renumbering twice.",
           f"{OLD}_renumber:", ("src/move_renumber.rs", 1), ("src/move_renumber/tests.rs", 1),
           ("src/move_in/writer_tests.rs", 1), ("tests/move_in_left_out.rs", 1),
           ("tests/support/lifecycle_scenarios.rs", 1))
    module("An interrupted offline rekey uses its persisted progress record.",
           f"{OLD}_rekey:", ("src/move_in.rs", 1), ("src/move_in/writer_tests.rs", 1))
    module("An interrupted runner move resumes from its persisted progress record.",
           f"{OLD}_runner_move:", ("src/move_in/runner.rs", 1))
    module("These SQL assertions look for the persisted move records by their common prefix.",
           f"key LIKE '{OLD}_%", ("tests/move_in_opencode.rs", 1), ("tests/move_in_pi.rs", 1))
    module("The local agent-data undo image keeps its existing field and format.",
           f'"{OLD}": state', ("src/agent_data/receiver.rs", 1))
    module("Memory writer fixtures keep the legacy harness field value.",
           f'harness: "{OLD}"', ("src/memory_tool.rs", 3), ("src/memory_tool_level_tests.rs", 1),
           ("src/memory_changed_tests.rs", 1))
    module("The verification fixture names the historical branch literally.",
           f"{OLD}-clean", ("src/dreamer/tasks/verify/lines_tests.rs", 5))

    # Only the reply lines that carried the old member are frozen by these tags.
    for version in range(5, 23):
        files = ["states.json", "cache-why.json"]
        if version >= 19:
            files.append("fed-app-context-states.json")
        if version >= 20:
            files.extend(("fed-phone-context-states.json", "fed-phone-context-states-unchanged.json"))
        module("The published app-read sample is pinned byte for byte by its tag.",
               f'"session_kind": "{OLD}"',
               *((f"testdata/mc-app-read-samples-v{version}/{file}", 1) for file in files))
    module("The tagged v5 app-read README is frozen with its samples.",
           f"{NAME}-3", ("testdata/mc-app-read-samples-v5/README.md", 2))
    module("These tagged READMEs describe their original sample bytes and names.",
           f"{OLD}.db", ("testdata/mc-app-read-samples-v5/README.md", 1),
           ("testdata/mc-app-read-samples-v6/README.md", 1),
           ("testdata/mc-user-commands-samples-v2/README.md", 2),
           ("testdata/mc-user-commands-samples-v4/README.md", 2))
    return result


ALLOW_LIST = allow_list()


def occurrences(path, contents, exceptions):
    # An exception only covers a match wholly inside the exact permitted bytes,
    # at that path, and only as many times as the existing file uses them.
    covered = set()
    for rule in exceptions:
        for i, permitted in enumerate(re.finditer(re.escape(rule.text.encode()), contents)):
            if i == rule.max_uses:
                break
            covered.update((match.start(), match.end()) for match in
                           RETIRED.finditer(contents, permitted.start(), permitted.end()))
    return [f"{path}:{contents.count(NEWLINE, 0, start) + 1}: {contents[start:end].decode()}"
            for start, end in (match.span() for match in RETIRED.finditer(contents))
            if (start, end) not in covered]


def scan(root, paths, allow):
    violations = []
    for name in sorted(set(paths)):
        path = root / name
        if RETIRED.search(name.encode()):
            violations.append(f"{name}: retired name in path")
        if path.is_symlink() or not path.is_file():
            continue
        violations.extend(occurrences(name, path.read_bytes(), allow.get(name, ())))
    return violations


def main():
    files = subprocess.check_output(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", *SCOPE],
        cwd=ROOT,
    )
    paths = [path.decode() for path in files.split(b"\0") if path]
    violations = scan(ROOT, paths, ALLOW_LIST)
    if violations:
        print("Retired session name outside the allow-list:", file=sys.stderr)
        print("\n".join(violations), file=sys.stderr)
        return 1
    print(f"Retired session name check: {len(set(paths))} files scanned")
    return 0


class GuardTests(unittest.TestCase):
    def test_rejects_all_spellings_in_files_and_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            name = f"{OLD}.txt"
            (root / name).write_text(f"safe\n{OLD.upper()} {NAME.title()} 3 {NAME}-3\n")
            self.assertEqual(len(scan(root, [name], {})), 4)

    def test_allow_list_is_path_literal_and_count_specific(self):
        file = "source.rs"
        permitted = f'"{OLD}_text"'
        exception = ExceptionRule(permitted, 1, "persisted key")
        data = f"{permitted}\n{permitted}\n{permitted.upper()}\n{OLD}_other\n".encode()
        self.assertEqual(occurrences(file, data, [exception]), [
            f"{file}:2: {OLD}", f"{file}:3: {OLD.upper()}", f"{file}:4: {OLD}",
        ])
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in [file, "another.rs"]:
                (root / name).write_text(permitted)
            self.assertEqual(scan(root, [file, "another.rs"], {file: [exception]}),
                             [f"another.rs:1: {OLD}"])


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        unittest.main(argv=[sys.argv[0]])
    sys.exit(main())
