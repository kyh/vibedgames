# vibedgames

Seed your coding agent with a game studio: design, scaffold, generate art and
audio, add multiplayer, tune feel, and ship browser games with the `vg` CLI.

```sh
claude plugin marketplace add kyh/vibedgames-plugins
claude plugin install vibedgames@vibedgames
```

Start with the `game-playbook` skill, which takes a one-line idea to a shipped
game and routes into the other 34. Skill list:
[`plugins/README.md`](../README.md).

## Data and network use

The skills are local text and scripts. Data leaves your machine only when a
skill runs a `vg` command that talks to the vibedgames service (vibedgames.com,
hosted on Cloudflare):

| Command           | Sends                                    | Where it goes                                                                                            | Kept                                   |
| ----------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `vg deploy`       | built game files; source with `--source` | vibedgames storage, served at `{slug}.vibedgames.com`                                                    | until the next deploy or game deletion |
| `vg generate`     | prompt and input files                   | a third-party AI model provider: the prompt via vibedgames, input files uploaded straight to its storage | not stored by vibedgames               |
| `vg playtest run` | game state snapshots                     | vibedgames, forwarded to a third-party AI model provider                                                 | not stored                             |
| multiplayer       | player messages                          | vibedgames multiplayer servers, relayed to players in the same room                                      | not stored                             |
| `vg login`        | device-code sign-in                      | vibedgames; the token is saved on your machine                                                           | until you log out or revoke it         |

Some skills also document third-party tools you install yourself (npm packages,
Playwright, uv). The skills never read credentials; `vg` uses only its own vibedgames token.
`vg` itself also checks npm for a newer version once a day (`VG_NO_AUTO_UPDATE=1` turns
that off), and `vg new`, `vg init` and `vg playtest` fetch templates, skills and tools
from GitHub and npm.

[Privacy Policy](https://vibedgames.com/privacy) ·
[Terms of Use](https://vibedgames.com/terms)
