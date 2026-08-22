import type { Doc } from "@/lib/doc";
import { siteConfig } from "@/lib/site-config";

export const privacyDoc: Doc = {
  path: "/privacy",
  title: "Privacy at Vibedgames",
  description:
    "What Vibedgames stores, why, where it lives, who it is shared with, and how to get it deleted — described in plain language against the actual schema.",
  lead: [
    {
      kind: "p",
      text: "This page describes what the Vibedgames platform stores about you and your games. It is written against the open-source data model rather than around it: every table named below exists in [packages/db](https://github.com/kyh/vibedgames/tree/main/packages/db), and you can read exactly what each column holds.",
    },
    {
      kind: "p",
      text: "The short version: we store what an account and a deploy need in order to work, we do not run advertising or third-party analytics trackers on the apex site, and we do not sell personal data.",
    },
  ],
  sections: [
    {
      heading: "What is collected",
      blocks: [
        {
          kind: "ul",
          items: [
            "**Account** — your name, email address, optional avatar URL, account role, and the invite code you signed up with. Password sign-ups store a hash, never the password itself.",
            "**Sessions** — a session token, its expiry, and the IP address and user agent the session was created from. These exist so a session can be listed and revoked.",
            "**API keys and CLI tokens** — a hashed key, its prefix, and its usage metadata, so `vg` can authenticate without a browser.",
            "**Games and deploys** — the game slug and name, and per deployment the file paths, MIME types, byte sizes and SHA-256 hashes of everything you uploaded. The file contents themselves live in object storage.",
            "**Generation and credits** — for each `vg generate` call: the model endpoint id, the pricing unit, the estimated and settled cost, and the timestamps. The credit ledger is an append-only list of integer amounts. Prompts are passed through to the model provider and are not stored in our database.",
          ],
        },
      ],
    },
    {
      heading: "What is not collected",
      blocks: [
        {
          kind: "p",
          text: "There is no advertising network, no cross-site tracking pixel and no third-party analytics script on vibedgames.com. Cloudflare, which serves the site, records standard request logs for operating and protecting the network. Games deployed by other people run on their own `{slug}.vibedgames.com` subdomains and are not audited by us — if a game you play collects something, that is the game author's doing, not the platform's.",
        },
      ],
    },
    {
      heading: "Cookies",
      blocks: [
        {
          kind: "p",
          text: "The only cookies the platform sets are the session cookies issued at sign-in. They are scoped to the apex domain, `vibedgames.com`, and deliberately not to game subdomains — deployed games are untrusted code, so a game can never read your session. There are no marketing or profiling cookies.",
        },
      ],
    },
    {
      heading: "Where data lives, and who processes it",
      blocks: [
        {
          kind: "ul",
          items: [
            "**Cloudflare** — hosting, D1 (the database), R2 (deployed game bundles and optional source archives), and Durable Objects (multiplayer rooms). Cloudflare is the infrastructure processor for essentially everything.",
            "**Generative model providers** — when you run `vg generate`, the prompt and any input files you supply are sent to the model provider that serves the endpoint you named, and the generated output comes back the same way. Only the billing metadata is retained on our side.",
            "**GitHub and npm** — used for the source repository, issue tracking and package distribution. They see whatever you choose to post or install there.",
          ],
        },
        {
          kind: "p",
          text: "Data is not sold, rented, or shared for advertising. It is disclosed only where required by law, or where necessary to investigate abuse of the platform.",
        },
      ],
    },
    {
      heading: "Public by design",
      blocks: [
        {
          kind: "p",
          text: "A deployed game is public: anyone with the URL can load it at `{slug}.vibedgames.com`. Deploying with `--source` additionally publishes a forkable source archive that any signed-in user can download — which is why it is off by default and has to be asked for explicitly. Do not put secrets in a game bundle; treat everything you deploy as published.",
        },
      ],
    },
    {
      heading: "Retention and deletion",
      blocks: [
        {
          kind: "p",
          text: "Deployments are single-active: shipping a new build replaces the previous one, and superseded bundles are removed from object storage. Deleting a game removes its database rows and its stored files. Deleting your account cascades to your games, deployments, API keys, credit ledger and generation records. Sessions expire on their own schedule and can be revoked early from [/settings](/settings).",
        },
        {
          kind: "p",
          text: `To request an export or a deletion you cannot perform yourself, open a request at [${siteConfig.issues}](${siteConfig.issues}) — or use the private security-advisory channel described on [Contact](/contact) if the request itself is sensitive.`,
        },
      ],
    },
    {
      heading: "Children and eligibility",
      blocks: [
        {
          kind: "p",
          text: "Vibedgames is a developer tool and is not directed at children. Accounts are intended for people old enough to agree to the terms of the services the platform is built on.",
        },
      ],
    },
    {
      heading: "Changes to this page",
      blocks: [
        {
          kind: "p",
          text: `This page is versioned with the rest of the site, so its history is public: every revision is visible at [${siteConfig.repository}](${siteConfig.repository}). Material changes will be reflected here before they take effect.`,
        },
      ],
    },
  ],
};
