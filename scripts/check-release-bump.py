#!/usr/bin/env python3
"""Keep a CI-certified release tree unchanged except for versions and public notes."""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True
from workspace_crates import workspace_crates

PACKAGE_MANIFESTS = {f"packages/{package}/package.json" for package in ("plugin", "pi-plugin", "cli")}
CARGO_LOCK = "Cargo.lock"


def git(*args):
    return subprocess.check_output(["git", *args])


def normalize_cargo_manifest(content):
    package_start = re.search(r"(?m)^\[package\][ \t]*\r?$", content)
    if package_start is None:
        raise RuntimeError("Cargo manifest has no [package] section")
    body_start = content.find("\n", package_start.start()) + 1
    remaining = content[body_start:]
    next_section = re.search(r"(?m)^\[[^\]\r\n]+\][ \t]*\r?$", remaining)
    body_end = len(content) if next_section is None else body_start + next_section.start()
    body = content[body_start:body_end]
    version_line = re.compile(r'(?m)^([ \t]*version[ \t]*=[ \t]*")[^"]+("[^\r\n]*)$')
    normalized, count = version_line.subn(r"\g<1><VERSION>\g<2>", body, count=1)
    if count != 1:
        raise RuntimeError("Cargo manifest has no version in its [package] section")
    return content[:body_start] + normalized + content[body_end:]


def normalize_cargo_lock(content, crate_names):
    blocks = re.split(r"(?m)(?=^\[\[package\]\][ \t]*\r?$)", content)
    found = {name: 0 for name in crate_names}
    normalized = []
    version_line = re.compile(r'(?m)^([ \t]*version[ \t]*=[ \t]*")[^"]+("[^\r\n]*)$')
    for block in blocks:
        name_match = re.search(r'(?m)^name = "([^"]+)"[ \t]*\r?$', block)
        if name_match is None or name_match.group(1) not in found:
            normalized.append(block)
            continue
        name = name_match.group(1)
        found[name] += 1
        block, count = version_line.subn(r"\g<1><VERSION>\g<2>", block, count=1)
        if count != 1:
            raise RuntimeError(f"Cargo.lock package {name} has no version")
        normalized.append(block)
    missing = sorted(name for name, count in found.items() if count != 1)
    if missing:
        raise RuntimeError(f"Cargo.lock must contain each workspace crate exactly once: {', '.join(missing)}")
    return "".join(normalized)


def cargo_package_field(content, field):
    package_start = re.search(r"(?m)^\[package\][ \t]*\r?$", content)
    if package_start is None:
        raise RuntimeError("Cargo manifest has no [package] section")
    body_start = content.find("\n", package_start.start()) + 1
    remaining = content[body_start:]
    next_section = re.search(r"(?m)^\[[^\]\r\n]+\][ \t]*\r?$", remaining)
    body_end = len(content) if next_section is None else body_start + next_section.start()
    body = content[body_start:body_end]
    match = re.search(rf'(?m)^[ \t]*{re.escape(field)}[ \t]*=[ \t]*"([^"]+)"[ \t]*\r?$', body)
    return None if match is None else match.group(1)


def validate_cargo_lock(content, version, crate_names):
    blocks = re.split(r"(?m)(?=^\[\[package\]\][ \t]*\r?$)", content)
    versions = {}
    for block in blocks:
        name = re.search(r'(?m)^name = "([^"]+)"[ \t]*\r?$', block)
        package_version = re.search(r'(?m)^version = "([^"]+)"[ \t]*\r?$', block)
        if name is not None and name.group(1) in crate_names:
            if name.group(1) in versions:
                raise RuntimeError(f"Cargo.lock contains duplicate workspace package {name.group(1)}")
            versions[name.group(1)] = None if package_version is None else package_version.group(1)
    if versions != {name: version for name in crate_names}:
        raise RuntimeError("Cargo.lock workspace package versions do not match the release version")


def check_bump(base, version, staged):
    crates = workspace_crates(Path.cwd(), lambda path: git("show", f"{base}:{path}").decode())
    manifests = PACKAGE_MANIFESTS | crates.keys()
    target = ":" if staged else "HEAD:"
    notes = {"CHANGELOG.md", f".cortexkit/release-notes/v{version}.md"}
    diff_args = ["--cached"] if staged else []
    targets = [] if staged else ["HEAD"]
    paths = git("diff", *diff_args, "--name-only", "-z", base, *targets, "--").decode().split("\0")
    for path in filter(None, paths):
        if path not in manifests | {CARGO_LOCK} | notes:
            raise RuntimeError(f"CI reuse refuses non-version/notes change: {path}")
        if path in manifests:
            before_text = git("show", f"{base}:{path}").decode()
            after_text = git("show", f"{target}{path}").decode()
            if path in PACKAGE_MANIFESTS:
                before = json.loads(before_text)
                after = json.loads(after_text)
                if after.get("version") != version:
                    raise RuntimeError(f"Release version mismatch: {path}")
                before.pop("version", None)
                after.pop("version", None)
                if before != after:
                    raise RuntimeError(f"CI reuse refuses non-version manifest change: {path}")
            else:
                if cargo_package_field(after_text, "version") != version:
                    raise RuntimeError(f"Release version mismatch: {path}")
                expected_name = crates[path]
                if cargo_package_field(after_text, "name") != expected_name:
                    raise RuntimeError(f"Cargo package name mismatch: {path}")
                if normalize_cargo_manifest(before_text) != normalize_cargo_manifest(after_text):
                    raise RuntimeError(f"CI reuse refuses non-version manifest change: {path}")
        elif path == CARGO_LOCK:
            before_text = git("show", f"{base}:{path}").decode()
            after_text = git("show", f"{target}{path}").decode()
            validate_cargo_lock(after_text, version, crates.values())
            if normalize_cargo_lock(before_text, crates.values()) != normalize_cargo_lock(after_text, crates.values()):
                raise RuntimeError("CI reuse refuses non-version Cargo.lock change")
        # Even a version-only edit must not change an executable bit or add a symlink.
        mode = git("ls-files", "--stage", "--", path).decode().split()[0] if staged else git("ls-tree", "HEAD", "--", path).decode().split()[0]
        if mode != "100644":
            raise RuntimeError(f"CI reuse refuses file mode change: {path}")
    if not staged:
        commits = git("rev-list", f"{base}..HEAD").decode().splitlines()
        if commits and (len(commits) != 1 or git("rev-parse", "HEAD^").decode().strip() != base):
            raise RuntimeError("CI reuse requires a single version/notes bump on the certified commit")
    print("Release bump contains only versions and public notes")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base")
    parser.add_argument("version")
    parser.add_argument("--staged", action="store_true")
    args = parser.parse_args()
    check_bump(args.base, args.version, args.staged)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, IndexError, subprocess.SubprocessError) as error:
        sys.exit(f"release-bump: {error}")
