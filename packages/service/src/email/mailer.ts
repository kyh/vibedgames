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
export const consoleMailer: Mailer = (email) => {
  console.info(`[email] to ${email.to}: ${email.subject}\n${email.text}`);

  return Promise.resolve();
};
