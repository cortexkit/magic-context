<h1 align="center">Magic Context</h1>

<p align="center">
  <strong>Cache-aware infinite context, cross-session memory, and background history compression for AI coding agents.</strong><br>
  Keeps your agent's memory intact — no matter how long the session runs.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@cortexkit/magic-context"><img src="https://img.shields.io/npm/v/@cortexkit/magic-context?label=cli&color=orange&style=flat-square" alt="npm @cortexkit/magic-context"></a>
  <a href="https://www.npmjs.com/package/@cortexkit/opencode-magic-context"><img src="https://img.shields.io/npm/v/@cortexkit/opencode-magic-context?label=opencode&color=blue&style=flat-square" alt="npm @cortexkit/opencode-magic-context"></a>
  <a href="https://www.npmjs.com/package/@cortexkit/pi-magic-context"><img src="https://img.shields.io/npm/v/@cortexkit/pi-magic-context?label=pi&color=purple&style=flat-square" alt="npm @cortexkit/pi-magic-context"></a>
  <a href="https://discord.gg/DSa65w8wuf"><img src="https://img.shields.io/discord/1488852091056295957?style=flat-square&logo=discord&logoColor=white&label=Discord&color=5865F2" alt="Discord"></a>
  <a href="https://github.com/cortexkit/magic-context/stargazers"><img src="https://img.shields.io/github/stars/cortexkit/magic-context?style=flat-square&color=yellow" alt="stars"></a>
  <a href="https://github.com/cortexkit/magic-context/commits"><img src="https://img.shields.io/github/last-commit/cortexkit/magic-context?style=flat-square&color=green" alt="last commit"></a>
  <a href="https://github.com/cortexkit/magic-context/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License"></a>
</p>

---

## Storage

All durable states live in a local SQLite database. If the database can't be opened, Magic Context disables itself and notifies the user.

| What | Path |
|------|------|
| SQLite database (tags, compartments, memories, dream queue, all state) | `~/.local/share/cortexkit/magic-context/context.db` |
| Embedding model cache (downloaded ONNX model, ~90 MB) | `~/.local/share/cortexkit/magic-context/models/` |
| Log file (diagnostic, non-essential) | `/tmp/{harness}/magic-context/magic-context.log` (e.g. `/tmp/opencode/magic-context/magic-context.log`) |

> **Sandboxed / ephemeral environments** — The SQLite database and embedding model cache **must persist** between sandbox resets to avoid data loss and repeated model downloads. These paths derive from `$XDG_DATA_HOME` (default `~/.local/share`); override by setting `$XDG_DATA_HOME` to point to a persistent mount. The log file uses the OS temp directory and is optional.

---

See [README.md](README.md) for full documentation.