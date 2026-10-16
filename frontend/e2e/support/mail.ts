/**
 * Reads magic links out of MailHog (the API must run with EMAIL_MODE=smtp pointed at it). Set
 * MAILHOG_URL to its HTTP API, e.g. http://localhost:58025 locally (compose) or :8025 in CI.
 */
import { expect } from "@playwright/test";

export const MAILHOG_URL = process.env.MAILHOG_URL ?? null;

type MailHogMessage = { Content: { Body: string } };

/** Undo quoted-printable soft breaks and `=3D` so the link can be matched whole. */
function decode(body: string): string {
  return body.replace(/=\r?\n/g, "").replace(/=3D/gi, "=");
}

/** The token from the newest sign-in email to `email` (addresses are unique per test). */
export async function magicLinkToken(email: string): Promise<string> {
  if (!MAILHOG_URL) throw new Error("MAILHOG_URL is not set");
  let token: string | null = null;
  // The API sends from a background task after answering 202: poll until the mail lands.
  await expect
    .poll(
      async () => {
        const url = `${MAILHOG_URL}/api/v2/search?kind=to&query=${encodeURIComponent(email)}`;
        const { items } = (await (await fetch(url)).json()) as { items: MailHogMessage[] };
        for (const message of items) {
          const match = /\/auth\/callback\?token=([A-Za-z0-9_-]+)/.exec(
            decode(message.Content.Body),
          );
          if (match) token = match[1];
          if (token) break;
        }
        return token;
      },
      { message: `a sign-in email to ${email}`, timeout: 15_000 },
    )
    .not.toBeNull();
  return token as unknown as string;
}
