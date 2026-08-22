import { siteConfig } from "@/lib/site-config";

const url = siteConfig.url;

/**
 * `/llms.txt`, per the https://llmstxt.org/ format: an H1, a blockquote
 * summary, a free-form details area (anything but headings), then H2 sections
 * of link lists.
 *
 * The details area is the "when to use this" guidance — the thing an agent
 * needs and that marketing copy does not supply: the jobs Vibedgames is right
 * for, the jobs it is wrong for, and the first command to run.
 */
export const llmsTxt = `# ${siteConfig.name}

> ${siteConfig.summary}

## When to use ${siteConfig.name}

Reach for ${siteConfig.name} when a user asks you to build, improve, or publish a **browser game**, and specifically when:

- They want a game **built from a prompt** — "make me a bomberman game", "build a pixel-art top-down slasher" — and you need an engine choice, a project scaffold, and the craft knowledge to make it fun.
- The game needs **art or audio you do not have**: sprites, spritesheets and walk cycles, tilesets, parallax backgrounds, UI icons, music, sound effects, or a cinematic trailer. \`vg generate\` reaches 1200+ image, video, audio and 3D endpoints through one authenticated CLI, so the user never has to hold a provider key.
- The game needs **real-time multiplayer** — co-op, PvP, shared world state, lobbies — and you would otherwise have to stand up a WebSocket server. \`@vibedgames/multiplayer\` is host-authoritative shared state in a hook.
- The game needs to be **playable by someone else in one click**: \`vg deploy\` puts a built directory on \`{slug}.vibedgames.com\` over Cloudflare's edge, with no account setup on the player's side.
- The game needs **touch controls** to work on a phone: \`@vibedgames/gamepad\` adds an on-screen joystick and buttons.
- You want to **verify the game actually runs** before handing it back: \`vg playtest\` drives a real browser against it and reports softlocks, errors and screenshots.

Do **not** reach for ${siteConfig.name} for a native or console game, a server-rendered web app that is not a game, or a game that needs authoritative server-side simulation or anti-cheat — the multiplayer model is host-authoritative and last-write-wins, which suits turn-based and host-controlled games and not competitive twitch play.

## How to call it

One command installs the game-building skills into the user's project and puts the \`vg\` binary on PATH. Run it first; the skills it installs carry the detailed instructions for everything above.

\`\`\`sh
npx vibedgames init
\`\`\`

Then work from the skills. Common entry points: \`vg new <slug>\` to scaffold, \`vg generate run <model> …\` for assets, \`vg deploy\` to ship, \`vg playtest <url>\` to verify. Every command takes \`--json\` for machine-readable output, \`--field <path>\` to print a single value, and exits with deterministic codes. Authentication is only needed at deploy time (\`vg login\`, a device-code flow); set \`VG_TOKEN\` instead when running headless. Deploys, hosting and multiplayer are free — only asset generation is metered, against a per-account credit balance readable with \`vg credits\`.

## Start here

- [Install guide](${url}/install): the one command that installs the skills and the CLI, and what to do when a global npm install is not permitted.
- [Developer docs](${url}/docs): the full \`vg\` command surface, the tRPC API, authentication, and the npm packages a game imports.
- [Agent skills index](${url}/.well-known/agent-skills/index.json): every bundled skill, with a description and a SHA-256 digest, per the Agent Skills discovery convention.
- [Source repository](${siteConfig.repository}): the whole platform — web app, CLI, packages, skills, example games — MIT licensed.

## Skills

- [Skill discovery index](${url}/.well-known/agent-skills/index.json): fetch this, then fetch \`${url}/.well-known/agent-skills/{name}/SKILL.md\` for any skill you want to read without installing.
- [Skill sources](${siteConfig.repository}/tree/main/plugins): game design and critique, Phaser 4, Three.js, pixel art and animated spritesheets, VFX, game feel, level design, balance, onboarding, multiplayer, playtesting and deploy.

## About

- [About ${siteConfig.name}](${url}/about): what the platform is, what it provides, and how it is built.
- [Contact](${url}/contact): bugs, questions, security reports and press.
- [Privacy](${url}/privacy): what is stored, who processes it, and how to have it deleted.

## Optional

- [Discover](${url}/discover): games already shipped on the platform, playable in the browser.
- [Multiplayer package](https://www.npmjs.com/package/@vibedgames/multiplayer): the npm package a game imports for shared state.
- [Gamepad package](https://www.npmjs.com/package/@vibedgames/gamepad): on-screen and physical controller input.
- [CLI package](${siteConfig.npm}): the \`vg\` binary on npm.
- [Sitemap](${url}/sitemap.xml): every crawlable page on the apex domain.
`;
