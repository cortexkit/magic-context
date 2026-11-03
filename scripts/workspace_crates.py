#!/usr/bin/env python3
"""Read release crate paths and package names from the Cargo workspace."""

import argparse
import json
from pathlib import Path
import tomllib


def workspace_crates(root, read=None):
    root = Path(root)
    read = read or (lambda path: (root / path).read_text())
    workspace = tomllib.loads(read("Cargo.toml"))["workspace"]
    excluded = {path for pattern in workspace.get("exclude", []) for path in root.glob(pattern)}
    members = {}
    for pattern in workspace["members"]:
        paths = sorted(root.glob(pattern)) if any(char in pattern for char in "*?[") else [root / pattern]
        for path in paths:
            if path in excluded:
                continue
            manifest = (path / "Cargo.toml").relative_to(root).as_posix()
            members[manifest] = tomllib.loads(read(manifest))["package"]["name"]
    if not members:
        raise ValueError("Cargo workspace has no release members")
    return members


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifests", action="store_true")
    args = parser.parse_args()
    crates = workspace_crates(Path(__file__).resolve().parent.parent)
    print("\n".join(crates) if args.manifests else json.dumps(crates))
