import type { Email } from "./mailer";

type Message = Omit<Email, "to">;

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export const passwordResetEmail = (url: string) => {
  const href = escapeHtml(url);

  return {
    html: `<p>Someone asked to reset the password for your vibedgames account.</p>
<p><a href="${href}">Choose a new password</a></p>
<p>The link works once and expires in an hour. If you didn't ask for this, ignore this email; your password stays the same.</p>`,
    subject: "Reset your vibedgames password",
    text: `Someone asked to reset the password for your vibedgames account.

Choose a new password: ${url}

The link works once and expires in an hour. If you didn't ask for this, ignore this email; your password stays the same.`,
  } satisfies Message;
};
