import { createFileRoute, Link } from "@tanstack/react-router";

import { CONTACT_URL, LegalPage, LegalSection } from "@/components/legal/legal-page";

const PrivacyPage = () => (
  <LegalPage title="Privacy Policy" updated="September 26, 2026">
    <LegalSection heading="Overview">
      <p>
        Vibedgames hosts browser games and provides the <code>vg</code> command-line tool and the
        vibedgames agent skills. This policy covers vibedgames.com, the game subdomains under it,
        the <code>vg</code> CLI and the vibedgames plugin. We collect what we need to run the
        service. We don’t sell your data, show ads or use third-party analytics.
      </p>
    </LegalSection>

    <LegalSection heading="What we collect">
      <ul>
        <li>
          <strong>Account:</strong> your name, email address and a hashed password.
        </li>
        <li>
          <strong>Sessions and security:</strong> the IP address and user agent of each signed-in
          session. We also count requests per IP address to rate-limit sign-in attempts.
        </li>
        <li>
          <strong>API keys:</strong> the keys you create for the CLI and CI, and their names.
        </li>
        <li>
          <strong>Games:</strong> the files you deploy, plus each game’s name and slug. If you
          deploy with <code>--source</code>, we also store your project source so that other
          signed-in users can fork it.
        </li>
        <li>
          <strong>Generation usage:</strong> for each asset generation request, the model used, its
          status and what it cost. This is how we keep your credit balance. We do not store your
          prompts or the generated files.
        </li>
        <li>
          <strong>Waitlist:</strong> your email address, if you join the waitlist.
        </li>
      </ul>
    </LegalSection>

    <LegalSection heading="How data leaves your machine">
      <p>
        The vibedgames skills are text files that run inside your coding agent on your machine.
        Nothing is sent to us until you, or your agent, run a <code>vg</code> command that talks to
        our servers:
      </p>
      <ul>
        <li>
          <code>vg deploy</code> uploads your built game, and your source if you pass{" "}
          <code>--source</code>.
        </li>
        <li>
          <code>vg generate</code> sends your prompt and any input files to our server. We pass them
          on to the third-party AI model provider that fulfils the request. That provider processes
          them under its own terms and policies.
        </li>
        <li>
          <code>vg playtest run</code> sends snapshots of the game’s state to our server while a
          model plays the game. We pass them to a third-party AI model provider to choose the next
          move and do not keep them.
        </li>
        <li>
          Multiplayer games relay player messages through our servers to the other players in the
          same room.
        </li>
      </ul>
    </LegalSection>

    <LegalSection heading="Cookies">
      <p>
        We set one session cookie, on vibedgames.com only, to keep you signed in. Games run on
        separate subdomains and cannot read it. We use no tracking or advertising cookies.
      </p>
    </LegalSection>

    <LegalSection heading="Who processes your data">
      <ul>
        <li>
          <strong>Cloudflare</strong> hosts the site, the database, file storage and the multiplayer
          servers.
        </li>
        <li>
          <strong>AI model providers</strong> receive the prompts, inputs and game state described
          above, and only when you run a command that needs them.
        </li>
      </ul>
    </LegalSection>

    <LegalSection heading="Retention">
      <p>
        Account data stays until you ask us to delete your account. Each game keeps only its current
        deployment: a new deploy replaces the old files, and deleting a game deletes its files.
        Credit and generation records stay with your account.
      </p>
    </LegalSection>

    <LegalSection heading="Your choices">
      <p>
        You can delete your games and API keys yourself. To have your account and all its data
        deleted, or to ask what we hold about you,{" "}
        <a href={CONTACT_URL} target="_blank" rel="noreferrer">
          open an issue
        </a>{" "}
        with your vibedgames username and we will follow up. Don’t include your email address or
        other personal details: issues are public.
      </p>
    </LegalSection>

    <LegalSection heading="Children">
      <p>
        Vibedgames accounts are not for children under 13, and we do not knowingly collect their
        data.
      </p>
    </LegalSection>

    <LegalSection heading="Changes">
      <p>
        When this policy changes, we will update the date at the top of this page. Also see our{" "}
        <Link to="/terms">Terms of Service</Link>.
      </p>
    </LegalSection>
  </LegalPage>
);

export const Route = createFileRoute("/privacy")({
  component: PrivacyPage,
  head: () => ({ meta: [{ title: "Privacy Policy — Vibedgames" }] }),
});
