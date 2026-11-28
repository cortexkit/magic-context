#!/usr/bin/env python3
"""Keep hand-written source files below 5,000 lines.

Checked: Rust under crates/, and TypeScript under packages/*/src and
packages/*/scripts. In-file Rust test modules (`#[cfg(test)] mod name { ... }`)
do not count toward a file's size. Test files, fixtures, test data and the
generated files named in GENERATED are not checked. Lockfiles and other
non-source files are outside the scan.

The scan covers tracked files and new files git does not ignore, so a new
oversized file fails before it is committed.
"""

import argparse
import re
import subprocess
import sys
import unittest
from pathlib import Path, PurePosixPath
from typing import NamedTuple


LIMIT = 5_000
REPORT_THRESHOLD = 4_000
ROOT = Path(__file__).resolve().parents[1]
RAW_STRING = re.compile(r'(?:br|cr|r)(#*)"')
TYPESCRIPT_SUFFIXES = (".ts", ".tsx", ".mts", ".cts")
# Packages keep their hand-written TypeScript in these top-level folders.
TYPESCRIPT_FOLDERS = {"src", "scripts"}
# Folders that hold tests, benchmarks or test inputs rather than product source.
TEST_FOLDERS = {"tests", "benches", "test-vectors", "__tests__"}
DATA_FOLDERS = {"fixtures", "__fixtures__", "testdata"}

# Generated files are not checked. Each entry names what writes it; an entry
# ending in "/" covers every file under that folder.
GENERATED: dict[str, str] = {
    "crates/mc-module/src/content_language.rs": (
        "Written by gen-content-language-directive.ts (crates_old/mc-module/gen/)."
    ),
    "packages/cli/src/lib/issue-log-templates.generated.ts": (
        "Written by packages/cli/scripts/generate-issue-log-templates.ts."
    ),
    "packages/plugin/src/features/magic-context/mural/mural-font.generated.ts": (
        "Written by packages/plugin/scripts/generate-mural-font.ts."
    ),
    "packages/plugin/src/hooks/magic-context/historian-prompt.generated.ts": (
        "Written by packages/plugin/scripts/build-historian-prompt.ts."
    ),
    "packages/plugin/src/hooks/magic-context/reference-seeds.generated.ts": (
        "Written by packages/plugin/scripts/build-reference-seeds.ts."
    ),
    "packages/plugin/src/hooks/magic-context/two-pass-prompts/prompts.generated.ts": (
        "Written by packages/plugin/scripts/build-two-pass-prompts.ts."
    ),
    "packages/plugin/src/tui-compiled/": (
        "Written by packages/plugin/scripts/build-tui.ts from packages/plugin/src/tui."
    ),
}

# Files already at or over the limit when this check was added. A pinned file
# may shrink but must not grow past its pin; each pin says why it exists.
EXCEPTIONS: dict[str, tuple[int, str]] = {
    # This file takes fixes from the 0.49 line, which keeps it whole. It is
    # split once the two lines are one, so that those fixes keep merging.
    "packages/pi-plugin/src/context-handler.ts": (
        14_811,
        "Grows only with fixes merged from the 0.49 line; split when the lines are one.",
    ),
    "packages/plugin/src/hooks/magic-context/inject-compartments.ts": (
        5_405,
        "Split when next worked on.",
    ),
    "packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts": (
        6_791,
        "Split when next worked on.",
    ),
    "packages/plugin/src/hooks/magic-context/transform.ts": (5_309, "Split when next worked on."),
}


class Token(NamedTuple):
    text: str
    start: int
    end: int


def tokens(source: str) -> list[Token]:
    """Tokenize enough Rust to match module braces without reading literal contents."""
    result = []
    i = 0
    while i < len(source):
        start = i
        if source[i].isspace():
            i += 1
            continue
        if source.startswith("//", i):
            end = source.find("\n", i)
            i = len(source) if end < 0 else end
            continue
        if source.startswith("/*", i):
            depth = 1
            i += 2
            while i < len(source) and depth:
                if source.startswith("/*", i):
                    depth += 1
                    i += 2
                elif source.startswith("*/", i):
                    depth -= 1
                    i += 2
                else:
                    i += 1
            if depth:
                raise ValueError("unterminated block comment")
            continue

        raw = RAW_STRING.match(source, i)
        if raw:
            closing = '"' + raw.group(1)
            end = source.find(closing, raw.end())
            if end < 0:
                raise ValueError("unterminated raw string")
            i = end + len(closing)
            result.append(Token("literal", start, i))
            continue
        if source[i] == '"':
            i += 1
            while i < len(source) and source[i] != '"':
                i += 2 if source[i] == "\\" else 1
            if i >= len(source):
                raise ValueError("unterminated string")
            i += 1
            result.append(Token("literal", start, i))
            continue
        if source[i] == "'":
            # A lifetime has no closing quote after one character or escape.
            end = i + 1
            if source.startswith("\\u{", end):
                close = source.find("}", end + 3)
                end = len(source) if close < 0 else close + 1
            elif source.startswith("\\x", end):
                end += 4
            elif source.startswith("\\", end):
                end += 2
            else:
                end += 1
            if end < len(source) and source[end] == "'":
                i = end + 1
                result.append(Token("literal", start, i))
                continue
        if source[i].isalpha() or source[i] == "_":
            if source.startswith("r#", i):
                i += 2  # A raw identifier is not a raw string, but is one module name.
            i += 1
            while i < len(source) and (source[i].isalnum() or source[i] == "_"):
                i += 1
        else:
            i += 1
        result.append(Token(source[start:i], start, i))
    return result


def group_end(items: list[Token], start: int, opening: str, closing: str) -> int:
    depth = 0
    for i in range(start, len(items)):
        if items[i].text == opening:
            depth += 1
        elif items[i].text == closing:
            depth -= 1
            if depth == 0:
                return i + 1
    raise ValueError(f"unclosed {opening}")


def test_module_spans(source: str) -> list[tuple[int, int]]:
    items = tokens(source)
    spans = []
    i = 0
    attribute = ["#", "[", "cfg", "(", "test", ")", "]"]
    while i < len(items):
        if [item.text for item in items[i : i + 7]] != attribute:
            i += 1
            continue
        start = i
        i += 7
        # Other outer attributes and visibility do not make a test module production code.
        while [item.text for item in items[i : i + 2]] == ["#", "["]:
            i = group_end(items, i + 1, "[", "]")
        if i < len(items) and items[i].text == "pub":
            i += 1
            if i < len(items) and items[i].text == "(":
                i = group_end(items, i, "(", ")")
        if i + 2 >= len(items) or items[i].text != "mod":
            continue
        i += 2  # Skip `mod` and the module name.
        if items[i].text != "{":
            continue  # A path module (`mod tests;`) removes no lines from this file.
        end = group_end(items, i, "{", "}")
        spans.append((items[start].start, items[end - 1].end))
        i = end
    return spans


def physical_lines(source: str) -> list[str]:
    """Lines as editors and `wc -l` count them: split at newlines only, keeping them."""
    parts = source.split("\n")
    lines = [part + "\n" for part in parts[:-1]]
    if parts[-1]:
        lines.append(parts[-1])
    return lines


def count_source_lines(source: str) -> int:
    spans = iter(test_module_spans(source))
    span = next(spans, None)
    count = 0
    offset = 0
    for line in physical_lines(source):
        end = offset + len(line)
        cursor = offset
        remaining = []
        touched = False
        while span is not None and span[0] < end:
            touched = True
            remaining.append(source[cursor : max(cursor, span[0])])
            cursor = min(end, span[1])
            if span[1] > end:
                break
            span = next(spans, None)
        remaining.append(source[cursor:end])
        # Preserve production code sharing a line with a test module, and blank lines outside it.
        if not touched or "".join(remaining).strip():
            count += 1
        offset = end
    return count


def count_lines(path: str, source: str) -> int:
    """A file's hand-written lines. TypeScript tests live in their own files, so every line counts."""
    if path.endswith(".rs"):
        return count_source_lines(source)
    return len(physical_lines(source))


def in_scope(path: str) -> bool:
    parts = PurePosixPath(path).parts
    if len(parts) >= 2 and parts[0] == "crates" and path.endswith(".rs"):
        return True
    return (
        len(parts) >= 4
        and parts[0] == "packages"
        and parts[2] in TYPESCRIPT_FOLDERS
        and path.endswith(TYPESCRIPT_SUFFIXES)
    )


def generated(path: str) -> bool:
    return any(
        path.startswith(entry) if entry.endswith("/") else path == entry for entry in GENERATED
    )


def exempt(path: str) -> bool:
    parts = PurePosixPath(path).parts
    name = parts[-1]
    folders = set(parts[:-1])
    return (
        bool(folders & (TEST_FOLDERS | DATA_FOLDERS))
        or name.endswith("tests.rs")
        or name == "test_support.rs"
        or re.search(r"\.(test|spec)\.[cm]?tsx?$", name) is not None
        or generated(path)
    )


def size_message(path: str, count: int) -> tuple[bool, str]:
    prefix = f"{path}: {count} hand-written lines"
    if path in EXCEPTIONS:
        pin, _reason = EXCEPTIONS[path]
        if count < LIMIT:
            return True, f"{prefix} (limit: under {LIMIT}); remove its exception."
        if count > pin:
            return True, f"{prefix} (pinned limit: {pin}); split it by area; do not raise the pin."
        if count < pin:
            return False, f"NOTICE {prefix} (pinned limit: {pin}); lower the pin to {count}."
    elif count >= LIMIT:
        return True, f"{prefix} (limit: under {LIMIT}); split it by area."
    return False, ""


def entry_problems(candidates: list[str], checked: list[str]) -> list[str]:
    """Pins and generated entries that no longer name a file this check would see."""
    problems = []
    for path in sorted(EXCEPTIONS.keys() - set(checked)):
        problems.append(f"{path}: not a checked source file; remove its exception.")
    for entry in sorted(GENERATED):
        if not any(
            path.startswith(entry) if entry.endswith("/") else path == entry for path in candidates
        ):
            problems.append(f"{entry}: no such source file; remove its generated entry.")
    for path, (_pin, reason) in sorted(EXCEPTIONS.items()):
        if not reason.strip() or "\n" in reason:
            problems.append(f"{path}: an exception needs a one-line reason.")
    return problems


class SelfTests(unittest.TestCase):
    def test_raw_strings_and_nested_module(self):
        source = '''fn production() {}
#[cfg(test)]
mod tests {
    const JSON: &str = r#"{"brace": "}"}"#;
    const SQL: &str = r"select '}'";
    const MORE: &str = r###"}"## }"###;
    const BYTES: &[u8] = br##"} "# }"##;
    const C: &std::ffi::CStr = cr#"}"#;
    // } and #[cfg(test)] mod fake {
    /* } /* nested { */ } */
    mod nested {
        fn chars() { let _ = ('}', '{', '\\'', '\\\\', '\\u{7d}', b'}'); }
    }
}
fn after() {}
'''
        self.assertEqual(count_source_lines(source), 2)

    def test_path_module_removes_nothing(self):
        source = "#[cfg(test)] mod x;\nmod production {\n    fn f() {}\n}\n"
        self.assertEqual(count_source_lines(source), 4)

    def test_non_test_module_and_blank_lines(self):
        source = "// comment\n\nmod production {\n    fn f() {}\n}\n"
        self.assertEqual(count_source_lines(source), 5)

    def test_strings_comments_and_lifetimes_outside_tests(self):
        source = '''const TEXT: &str = "#[cfg(test)] mod fake { \\" }";
/* #[cfg(test)] mod fake { } */
fn borrow<'a>(s: &'a str) -> &'a str { s }
#[cfg(test)]
mod tests { const S: &str = "} \\" {"; }
'''
        self.assertEqual(count_source_lines(source), 3)

    def test_attributes_visibility_and_multiline_cfg(self):
        source = "#[cfg(\n test\n)]\n#[allow(dead_code)]\npub(crate) mod checks {\n}\n"
        self.assertEqual(count_source_lines(source), 0)
        self.assertEqual(count_source_lines("#[cfg(test)] mod r#type {}\n"), 0)

    def test_multiple_modules_and_shared_lines(self):
        source = "#[cfg(test)] mod one {}\n\nmod prod { #[cfg(test)] mod two {} }\n"
        self.assertEqual(count_source_lines(source), 2)

    def test_empty_and_no_final_newline(self):
        self.assertEqual(count_source_lines(""), 0)
        self.assertEqual(count_source_lines("fn f() {}"), 1)
        self.assertEqual(count_source_lines("#[cfg(test)] mod tests {}"), 0)

    def test_only_newlines_end_lines(self):
        # Python's splitlines() would also split at these; editors and `wc -l` do not.
        source = 'const S: &str = "a\u2028b\u2029c\x0cd\x1ce";\n'
        self.assertEqual(count_source_lines(source), 1)
        self.assertEqual(count_lines("packages/a/src/x.ts", 'const s = "a\u2028b";\n'), 1)

    def test_typescript_counts_every_line(self):
        source = "// comment\n\nconst text = `\n}\n`;\n/* block */\nexport {};"
        self.assertEqual(count_lines("packages/a/src/x.ts", source), 7)
        self.assertEqual(count_lines("packages/a/src/x.ts", ""), 0)

    def test_scope(self):
        for path in (
            "crates/a/src/lib.rs", "crates/a/build.rs", "packages/a/src/x.ts",
            "packages/a/src/deep/x.tsx", "packages/a/scripts/x.ts", "packages/a/src/x.d.mts",
        ):
            with self.subTest(path=path):
                self.assertTrue(in_scope(path))
        for path in (
            "crates/a/gen/x.ts", "crates_old/a/src/lib.rs", "packages/a/src-tauri/src/db.rs",
            "packages/a/tests/x.ts", "packages/a/x.ts", "packages/a/src/x.js",
            "packages/a/src/x.json", "Cargo.lock", "bun.lock", "scripts/gate.ts",
        ):
            with self.subTest(path=path):
                self.assertFalse(in_scope(path))

    def test_file_exemptions(self):
        for path in (
            "crates/a/tests/x.rs", "crates/a/benches/x.rs", "crates/a/test-vectors/x.rs",
            "crates/a/src/foo_tests.rs", "crates/a/src/tests.rs", "crates/a/src/test_support.rs",
            "crates/a/testdata/x.rs", "packages/a/src/x.test.ts", "packages/a/src/x.test.tsx",
            "packages/a/src/x.spec.ts", "packages/a/src/x.test.mts", "packages/a/src/__tests__/x.ts",
            "packages/a/src/fixtures/x.ts", "packages/a/src/__fixtures__/x.ts",
            "packages/a/scripts/fixtures/x.ts",
            "packages/cli/src/lib/issue-log-templates.generated.ts",
            "packages/plugin/src/tui-compiled/slots/sidebar-content.tsx",
        ):
            with self.subTest(path=path):
                self.assertTrue(exempt(path))
        for path in (
            "crates/a/src/testing.rs", "packages/a/src/testing.ts", "packages/a/src/latest.ts",
            "packages/a/src/x.generated.ts", "packages/plugin/src/tui/index.tsx",
        ):
            with self.subTest(path=path):
                self.assertFalse(exempt(path))

    def test_limit_and_pins(self):
        path = "crates/self-test.rs"
        self.assertFalse(size_message(path, LIMIT - 1)[0])
        self.assertTrue(size_message(path, LIMIT)[0])
        EXCEPTIONS[path] = (LIMIT + 10, "Self-test fixture.")
        try:
            self.assertEqual(size_message(path, LIMIT + 10), (False, ""))
            self.assertTrue(size_message(path, LIMIT + 11)[0])
            failed, message = size_message(path, LIMIT)
            self.assertFalse(failed)
            self.assertIn("lower the pin", message)
            failed, message = size_message(path, LIMIT - 1)
            self.assertTrue(failed)
            self.assertIn("remove its exception", message)
        finally:
            del EXCEPTIONS[path]

    def test_stale_and_unexplained_entries(self):
        generated_files = sorted(
            entry + "x.tsx" if entry.endswith("/") else entry for entry in GENERATED
        )
        checked = sorted(EXCEPTIONS)
        self.assertEqual(entry_problems(generated_files + checked, checked), [])
        problems = entry_problems(generated_files[1:] + checked, checked[1:])
        self.assertTrue(any("remove its exception" in problem for problem in problems))
        self.assertTrue(any("remove its generated entry" in problem for problem in problems))
        path = "crates/self-test.rs"
        EXCEPTIONS[path] = (LIMIT, "")
        try:
            problems = entry_problems(generated_files + checked + [path], checked + [path])
            self.assertEqual(problems, [f"{path}: an exception needs a one-line reason."])
        finally:
            del EXCEPTIONS[path]


def candidate_paths() -> list[str]:
    """Tracked files plus new files git does not ignore, under the checked roots."""
    listed = subprocess.check_output(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "crates/", "packages/"],
        cwd=ROOT,
    )
    paths = {path for path in listed.decode().split("\0") if path and in_scope(path)}
    # A tracked file deleted from the work tree is no longer there to check.
    return sorted(path for path in paths if (ROOT / path).is_file())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", action="store_true", help="list files with at least 4,000 hand-written lines")
    parser.add_argument("--self-test", action="store_true", help="run the scanner's regression tests")
    args = parser.parse_args()
    if args.self_test:
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(SelfTests)
        return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1

    try:
        candidates = candidate_paths()
        paths = [path for path in candidates if not exempt(path)]
        failed = False
        counts = []
        for path in paths:
            try:
                count = count_lines(path, (ROOT / path).read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, ValueError) as error:
                print(f"{path}: cannot count source lines: {error}")
                failed = True
                continue
            counts.append((count, path))
            violation, message = size_message(path, count)
            failed |= violation
            if message:
                print(message)
        for problem in entry_problems(candidates, paths):
            print(problem)
            failed = True
        if args.report:
            print(f"Files with at least {REPORT_THRESHOLD} hand-written lines (excluding in-file Rust tests):")
            for count, path in sorted(counts, key=lambda item: (-item[0], item[1])):
                if count >= REPORT_THRESHOLD:
                    print(f"{count:6}  {path}")
        rust = sum(1 for _count, path in counts if path.endswith(".rs"))
        print(
            f"File size check {'FAILED' if failed else 'passed'}: {rust} Rust and "
            f"{len(counts) - rust} TypeScript source files checked (limit: under {LIMIT})."
        )
        return 1 if failed else 0
    except (OSError, subprocess.CalledProcessError) as error:
        print(f"File size check failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
