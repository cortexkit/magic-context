import { expect, test } from "bun:test";
import { isResolvedProjectId } from "./resolved-project-id";

test.each(["git:root", "dir:0123456789ab", "pj-7a213b44"])("%s is a resolved project id", (value) =>
    expect(isResolvedProjectId(value)).toBe(true));

test.each([
    "",
    "/repo/project",
    "relative/project",
    "/repo/pj-project",
    "git-project",
])("%s is not a resolved project id", (value) => expect(isResolvedProjectId(value)).toBe(false));
