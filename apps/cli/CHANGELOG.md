# Changelog

## 0.0.4 — 2026-06-03

- `vg new` scaffolder — pull an official engine template (phaser, threejs) or a minimal canvas starter
- one-command local DB setup + headless dev auth (`VG_TOKEN` overrides the saved login)
- `vg media` surface (run/status/models/schema/pricing/docs/upload) hardened: prints result URLs, exits non-zero on download failure, collision-safe `--download`, path-traversal + HTTPS guards on fal CDN, POSIX `--` terminator and `--key=value` argv support
- local R2 isolation so local deploys don't depend on prod bucket state
