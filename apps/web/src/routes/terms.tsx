import { createFileRoute, Link } from "@tanstack/react-router";

import { CONTACT_URL, LegalPage, LegalSection } from "@/components/legal/legal-page";

const TermsPage = () => (
  <LegalPage title="Terms of Service" updated="September 26, 2026">
    <LegalSection heading="Agreement">
      <p>
        These terms cover your use of vibedgames.com, the game subdomains under it, the{" "}
        <code>vg</code> CLI and the vibedgames plugin (together, “the service”). By using the
        service you agree to them. If you don’t agree, don’t use the service.
      </p>
    </LegalSection>

    <LegalSection heading="Accounts">
      <p>
        You are responsible for your account and for anything done with its password or API keys.
        Keep them secret. Revoke a key as soon as you think it has leaked.
      </p>
    </LegalSection>

    <LegalSection heading="Your games">
      <p>
        You keep ownership of what you deploy. You give us permission to store, serve and display it
        so we can run the service, which includes showing your game to anyone who visits its URL. If
        you deploy with <code>--source</code>, any signed-in user can fork and change your project.
        Only publish source you are willing to share.
      </p>
      <p>You must have the rights to everything you deploy.</p>
    </LegalSection>

    <LegalSection heading="Acceptable use">
      <p>Don’t use the service to:</p>
      <ul>
        <li>
          host malware, phishing pages or anything that collects credentials or payment details;
        </li>
        <li>publish illegal content, or content that infringes someone else’s rights;</li>
        <li>harass, threaten or exploit anyone, especially minors;</li>
        <li>attack, overload or probe the service or other users’ games;</li>
        <li>get around generation credits, rate limits or other usage limits.</li>
      </ul>
      <p>
        We may remove content or suspend accounts that break these rules, and we may do so without
        notice.
      </p>
    </LegalSection>

    <LegalSection heading="Generation credits">
      <p>
        New accounts get free generation credits. Credits have no cash value, can’t be transferred,
        and may change. Generated assets come from third-party AI models. You are responsible for
        how you use them, and each model’s own terms may also apply.
      </p>
    </LegalSection>

    <LegalSection heading="Open-source code">
      <p>
        The vibedgames source code, including the CLI and skills, is released under the MIT License.
        These terms cover the hosted service, not your rights to that code.
      </p>
    </LegalSection>

    <LegalSection heading="No warranty">
      <p>
        The service is provided “as is” and “as available”, without warranties of any kind. We don’t
        guarantee that it will be uninterrupted, error-free or that your data will be preserved.
        Keep your own copies of your games.
      </p>
    </LegalSection>

    <LegalSection heading="Limitation of liability">
      <p>
        To the maximum extent permitted by law, vibedgames is not liable for indirect, incidental,
        special or consequential damages, or for lost data or profits, arising from your use of the
        service.
      </p>
    </LegalSection>

    <LegalSection heading="Changes and termination">
      <p>
        We may change these terms or the service, including discontinuing it. When the terms change,
        we will update the date at the top of this page, and continuing to use the service means you
        accept the new terms. You can stop using the service at any time.
      </p>
    </LegalSection>

    <LegalSection heading="Contact">
      <p>
        Questions go in{" "}
        <a href={CONTACT_URL} target="_blank" rel="noreferrer">
          GitHub issues
        </a>
        . See the <Link to="/privacy">Privacy Policy</Link> for how we handle your data.
      </p>
    </LegalSection>
  </LegalPage>
);

export const Route = createFileRoute("/terms")({
  component: TermsPage,
  head: () => ({ meta: [{ title: "Terms of Service — Vibedgames" }] }),
});
