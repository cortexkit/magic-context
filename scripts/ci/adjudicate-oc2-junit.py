"""Check Bun's JUnit report against exact, version-selected known failures."""

import argparse
import json
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path


def read_report(path):
    root = ET.parse(path).getroot()
    if root.tag != "testsuites" or root.get("name") != "bun test":
        raise ValueError("expected a Bun JUnit report")

    def cases(suite, file, parents):
        for node in suite:
            if node.tag == "testsuite":
                yield from cases(node, file, [*parents, node.attrib["name"]])
            elif node.tag == "testcase":
                if node.get("file") != file:
                    raise ValueError(f"JUnit testcase is not in suite file {file}")
                name = " > ".join([*parents, node.attrib["name"]])
                state = "failed" if node.find("failure") is not None else (
                    "skipped" if node.find("skipped") is not None else "passed"
                )
                yield (file, name), state
            elif node.tag not in {"system-out", "system-err", "properties"}:
                raise ValueError(f"unclassified JUnit result: {node.tag} in {file}")

    if root.findall(".//error") or int(root.get("errors", "0")):
        raise ValueError("Bun reported an error outside the expected test failures")
    results = defaultdict(list)
    for suite in root:
        if suite.tag != "testsuite":
            raise ValueError(f"unclassified JUnit result: {suite.tag}")
        file = suite.attrib["file"]
        for identity, state in cases(suite, file, []):
            results[identity].append(state)
    states = [state for group in results.values() for state in group]
    if not states or (
        len(states), states.count("failed"), states.count("skipped")
    ) != tuple(int(root.attrib[key]) for key in ("tests", "failures", "skipped")):
        raise ValueError("Bun's JUnit summary disagrees with its testcases")
    return results, states.count("failed")


def adjudicate(results, known, status, failures):
    errors = []
    if status != int(failures > 0):
        errors.append(f"Bun exit {status} is inconsistent with {failures} reported failures")
    expected = {(entry["path"], entry["name"]): entry for entry in known}
    for identity, states in sorted(results.items()):
        if "failed" in states and identity not in expected:
            errors.append(f"Unlisted failure: {identity[0]}: {identity[1]}")
    for identity, entry in expected.items():
        file, name = identity
        found = results.get(identity, [])
        if found == ["failed"]:
            print(f"Known {entry['class']} (ran and failed): {file}: {name} — {entry['reason']}")
        elif found == ["passed"]:
            errors.append(f"Unexpected pass: {file}: {name}; remove its knownFailures entry")
        else:
            errors.append(f"Known failure must run exactly once: {file}: {name} (got {found})")
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("known", type=Path)
    parser.add_argument("report", type=Path)
    parser.add_argument("status", type=int)
    args = parser.parse_args()
    try:
        known = json.loads(args.known.read_text(encoding="utf-8"))
        results, failures = read_report(args.report)
        errors = adjudicate(results, known, args.status, failures)
    except (OSError, ValueError, KeyError, ET.ParseError) as error:
        errors = [f"Cannot adjudicate OpenCode 2 JUnit results: {error}"]
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
