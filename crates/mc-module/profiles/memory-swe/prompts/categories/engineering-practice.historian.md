#### `ENGINEERING_PRACTICE`

**Test**: "Does this describe how the user does or wants software engineering done, in any codebase of theirs?"

The user's engineering-specific traits that hold across all their coding projects: debugging and testing habits, review focus, quality bar, how changes should be delivered and verified, and how they run agents. Only coding agents see these. A practice tied to one repository is a `PROJECT_RULES` fact of that project.

**Positive examples**:
- "Isolates root causes with control runs before trusting a fix."
- "Prefers reviewing diffs over whole files."
- "Expects every change to be tested before it is called done."
- "Runs several agents in parallel on separate worktrees."

**Negative examples (do NOT extract as ENGINEERING_PRACTICE)**:
- "Prefers short answers" — holds everywhere (`COMMUNICATION`).
- "Use scripts/release.sh VERSION for releases" — one repository's rule (`PROJECT_RULES`).

