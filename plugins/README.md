# Plugins

The game studio, as skills. Six Claude Code plugins, listed in
[`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json), each a
`.claude-plugin/plugin.json` manifest plus a `skills/` directory.

These are the product, not tooling for this repo: `vg init` installs them into a
user's project (for Claude Code, Cursor and Codex), and `vg update` refreshes
them. Claude Code users can also install straight from the marketplace:
`claude plugin marketplace add kyh/vibedgames`, then
`claude plugin install <plugin>@vibedgames`. An agent that has them can do what
a studio does — design, scaffold, generate art, add multiplayer, tune feel, ship.

| Plugin                               | Skills                                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`game-craft`](./game-craft)         | `game-playbook` · `ask-me` · `teach-me` · `game-feel` · `game-balance` · `game-ui` · `level-design` · `onboarding` · `animation` · `vfx` · `design-lenses` · `finish-it` |
| [`game-engines`](./game-engines)     | `phaser` · `threejs` · `capacitor-ios`                                                                                                                                   |
| [`game-features`](./game-features)   | `multiplayer` · `gamepad`                                                                                                                                                |
| [`generate`](./generate)             | `generate` · `model-catalog` · `model-prompting` · `media-workflow` · `pixel-art` · `character-design` · `cinematography` · `storytelling` · `regenerate-3d`             |
| [`asset-pipeline`](./asset-pipeline) | `animated-spritesheets` · `aseprite` · `asset-pipeline` · `image-to-threejs` · `pixel-snapper`                                                                           |
| [`tooling`](./tooling)               | `deploy` · `fork` · `playtest` · `skill-creator`                                                                                                                         |

`game-playbook` is the entry point — the build order from a one-line idea to a
shipped game; the rest are the deep modules it routes into.

## Editing them

```sh
pnpm dogfood        # build + npm-link the local vg CLI, sync .claude/skills/
pnpm dogfood:reset  # undo the link
```

`pnpm dogfood` mirrors every `plugins/*/skills/*` into `.claude/skills/` as a
relative symlink (creating new ones, removing stale ones) and validates
cross-skill references. Those symlinks are committed, so a fresh clone — or a
remote Claude Code session — resolves the skills with no setup; only the
`npm link` step is per-machine.

Re-run `pnpm dogfood` after adding or removing a skill, then commit the
`.claude/skills/` change.

## Conventions

- One skill = one directory with a `SKILL.md` whose frontmatter `description`
  is what triggers it. Write the description as _when to use this_, not what it
  contains — it is the only part always in context.
- A skill that changes a user's output owns the lesson. Durable craft belongs
  in the SKILL.md (or its scripts), never only in a session note.
- Adding a skill to a new plugin means adding the plugin to
  `.claude-plugin/marketplace.json` too.
- End-user-facing skills never name the generation provider as a brand — model
  endpoint IDs pass through verbatim, everything else is just "the CLI".
