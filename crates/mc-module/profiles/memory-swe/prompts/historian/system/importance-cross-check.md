### Importance is not coupled to activity type

A bug fix can be 85+ if it revealed a deep systemic constraint future code must respect. An architectural design discussion can be 30 if the conclusion was obvious in retrospect. A docs change can be 70 if it established a naming convention all future docs follow. A release can be 20 if it just shipped what was already built without controversy.

**Cross-check examples:**
- Bug fix that established "scheduler must check non-null before threshold logic" → 85+ (future code must respect this).
- Bug fix that swapped a CSS class name → 25 (current state shows the fix).
- Design discussion that landed "we use language-scoped formatter maps" → 80 (this constrains all future config code).
- Design discussion that landed "let's use cargo workspaces" → 50 (mechanical decision, easy to recall from `Cargo.toml`).
- Feature shipping markdown support → 75 (concrete capability, recallable but the user-facing decision matters).
- Feature shipping a CLI flag alias → 30 (small, current state shows the flag).
- Release cutting v0.21.0 with major changes → 60 (notable shipping event, details in release notes).
- Release cutting a typo-fix patch → 15.

