import type { Email } from "./mailer";

type Message = Omit<Email, "to">;

const codeMessage = (lead: string, otp: string, ignore: string) =>
  ({
    html: `<p>${lead}</p>
<p style="font-size:24px;font-weight:600;letter-spacing:4px">${otp}</p>
<p>It expires in 5 minutes. ${ignore}</p>`,
    text: `${lead}

${otp}

It expires in 5 minutes. ${ignore}`,
  }) satisfies Omit<Message, "subject">;

export const signInCodeEmail = (otp: string) =>
  ({
    ...codeMessage(
      "Your vibedgames sign-in code:",
      otp,
      "If you didn't ask for it, ignore this email.",
    ),
    subject: `${otp} is your vibedgames sign-in code`,
  }) satisfies Message;

export const confirmEmailCode = (otp: string) =>
  ({
    ...codeMessage(
      "Enter this code in Settings to confirm this address for your vibedgames account:",
      otp,
      "If you didn't ask for it, ignore this email.",
    ),
    subject: `${otp} confirms your email for vibedgames`,
  }) satisfies Message;
