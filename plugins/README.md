# Plugins

The game studio, as skills. One Claude Code plugin, [`vibedgames`](./vibedgames),
listed in [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json):
a `.claude-plugin/plugin.json` manifest plus a flat `skills/` directory. One
plugin, not one per area, so a single install gets the whole studio and skills
can point at each other.

These are the product, not tooling for this repo: `vg init` installs them into a
user's project (for Claude Code, Cursor and Codex), and `vg update` refreshes
them. Claude Code users can also install straight from the marketplace:
`claude plugin marketplace add kyh/vibedgames-plugins`, then
`claude plugin install vibedgames@vibedgames`. An agent that has them can do what
a studio does — design, scaffold, generate art, add multiplayer, tune feel, ship.

| Area           | Skills                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Craft          | `game-playbook` · `ask-me` · `teach-me` · `game-feel` · `game-balance` · `game-ui` · `level-design` · `onboarding` · `animation` · `vfx` · `design-lenses` · `finish-it` |
| Engines        | `phaser` · `threejs` · `capacitor-ios`                                                                                                                                   |
| Features       | `multiplayer` · `gamepad`                                                                                                                                                |
| Generation     | `generate` · `model-catalog` · `model-prompting` · `media-workflow` · `pixel-art` · `character-design` · `cinematography` · `storytelling` · `regenerate-3d`             |
| Asset pipeline | `animated-spritesheets` · `aseprite` · `asset-pipeline` · `image-to-threejs` · `pixel-snapper`                                                                           |
| Tooling        | `deploy` · `fork` · `playtest` · `skill-creator`                                                                                                                         |

`game-playbook` is the entry point — the build order from a one-line idea to a
shipped game; the rest are the deep modules it routes into.

## Editing them

Edit here, never in [`kyh/vibedgames-plugins`](https://github.com/kyh/vibedgames-plugins).
That repo is a read-only mirror of `plugins/` and `.claude-plugin/`, pushed by
`.github/workflows/sync-plugins.yml` on every change to main. It exists because
the plugin directory and `vg init` both download a whole repo, and the
game assets make this one far too big for either.

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
- New skills go in `vibedgames/skills/`. Don't split out a second plugin; one
  install should get the whole studio.
- End-user-facing skills never name the generation provider as a brand — model
  endpoint IDs pass through verbatim, everything else is just "the CLI".
