/** Sends account emails (verification, password reset). Swap the class to change provider. */
export type Email = { to: string; subject: string; text: string; html: string };

export interface Mailer {
  send(email: Email): Promise<void>;
}

/** Prints emails instead of sending them. For local development and tests. */
export class ConsoleMailer implements Mailer {
  readonly sent: Email[] = [];

  constructor(private readonly log: (line: string) => void = console.log) {}

  async send(email: Email) {
    this.sent.push(email);
    this.log(`[mail] to ${email.to}: ${email.subject}\n${email.text}`);
  }
}

/** Sends through Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email). */
export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(email: Email) {
    const response = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [email.to], subject: email.subject, text: email.text, html: email.html }),
    });
    if (!response.ok) throw new Error(`Could not send email (${response.status}): ${await response.text()}`);
  }
}

function escape(text: string) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A short email with one button. */
export function actionEmail(input: { to: string; subject: string; intro: string; action: string; url: string }): Email {
  return {
    to: input.to,
    subject: input.subject,
    text: `${input.intro}\n\n${input.action}: ${input.url}\n\nIf you didn't ask for this, you can ignore this email.`,
    html: `<p>${escape(input.intro)}</p><p><a href="${escape(input.url)}">${escape(input.action)}</a></p><p>If you didn't ask for this, you can ignore this email.</p>`,
  };
}
