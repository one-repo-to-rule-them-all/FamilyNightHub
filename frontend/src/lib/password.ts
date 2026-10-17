/**
 * Account passwords (ADR-0014 "Password rules"): 12–256 characters, not all one character, no
 * composition rules (NIST SP 800-63B). The server is the authority and also rejects the username,
 * the email and common long passwords; this only catches the obvious before a round trip.
 */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

/** Why `password` can't be used, or null when it can (as far as the browser can tell). */
export function passwordProblem(password: string, confirm: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (new Set(password).size === 1) return "Use more than one repeated character.";
  if (password !== confirm) return "The two passwords don't match.";
  return null;
}
