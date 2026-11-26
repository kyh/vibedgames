export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type Mailer = (email: Email) => Promise<void>;

export const EMAIL_FROM = "vibedgames <noreply@vibedgames.com>";

interface ResendOptions {
  apiKey: string;
  from?: string;
  /** Overridable so tests never reach Resend. */
  fetch?: typeof fetch;
}

/**
 * Resend's REST API rather than its SDK: one POST is the whole integration, and
 * the Worker bundle stays free of the SDK's Node-oriented dependencies.
 */
export const resendMailer =
  ({ apiKey, from = EMAIL_FROM, fetch: send = fetch }: ResendOptions) =>
  async (email: Email) => {
    const response = await send("https://api.resend.com/emails", {
      body: JSON.stringify({ from, ...email, to: [email.to] }),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      method: "POST",
    });

    if (!response.ok) {
      throw new Error(`Resend refused the email (${response.status}): ${await response.text()}`);
    }
  };

/** Local dev without a key: the message, link included, lands in the dev server's log. */
export const consoleMailer: Mailer = async (email) => {
  console.info(`[email] to ${email.to}: ${email.subject}\n${email.text}`);

  await Promise.resolve();
};

/** What a deployment without a key logs once, in place of every email it cannot send. */
export const NO_EMAIL_WARNING =
  "[email] RESEND_API_KEY is unset: this deployment sends no email, so password reset is refused and email verification is skipped.";

interface MailerSettings {
  apiKey: string | undefined;
  /** A request to the local dev server, the only place an email may be logged. */
  local: boolean;
  fetch?: typeof fetch;
}

/**
 * Resend when a key is set; without one, the log on the local dev server and
 * nothing anywhere else, since a logged reset link is a live login.
 */
export const mailerOf = ({ apiKey, local, fetch: send }: MailerSettings) => {
  if (apiKey !== undefined && apiKey !== "") {
    return resendMailer(send === undefined ? { apiKey } : { apiKey, fetch: send });
  }

  return local ? consoleMailer : undefined;
};
