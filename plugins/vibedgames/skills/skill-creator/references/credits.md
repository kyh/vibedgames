# Credits and License

This skill's tooling is a Node port of the Python scripts in Anthropic's
`skill-creator` skill (<https://github.com/anthropics/skills>, Copyright 2026
Anthropic, PBC., Apache License 2.0):

- `scripts/quick-validate.mjs` ← `quick_validate.py` (frontmatter and naming checks,
  with the same error messages)
- `scripts/init-skill.mjs` ← `init_skill.py` (directory scaffold)
- `scripts/package-skill.mjs` ← `package_skill.py` (validate, then zip)
- `references/workflows.md` and `references/output-patterns.md` ← the skill's
  reference docs of the same names

Changes: ported from Python to dependency-free Node (no PyYAML; our own zip
writer), rewritten scaffold text and examples for game skills, an `example.mjs`
in place of `example.py`, and wording made agent-neutral. The code lives in
`packages/asset-tools/src/skill/` in the vibedgames repo and is bundled into
`scripts/_lib/asset-tools.mjs`.

The Apache License 2.0 is reproduced in [apache-2.0.txt](apache-2.0.txt).
