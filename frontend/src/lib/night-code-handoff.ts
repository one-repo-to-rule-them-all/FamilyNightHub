/**
 * Where the plaintext night code lives in the browser (04-frontend.md "Night code on the TV").
 *
 * The API returns the code exactly once (create / rotate) and stores only its hash, so the server
 * can never give it back. The browser keeps it in `sessionStorage`, keyed by night: scoped to this
 * tab, gone when the tab closes, never sent anywhere. That covers both hand-offs:
 *
 * - the host creates the night on the TV's browser, then "Use this browser as the TV": same tab,
 *   so /tv/[session] reads the code the host page just stored;
 * - a TV paired on an earlier night: the TV asks for the code once (typed from the host's phone)
 *   and keeps it the same way.
 *
 * Every access is guarded: storage can be disabled (private mode, policies) and the screens still
 * work, the TV then just asks again.
 */

const PREFIX = "fnh.nightCode.";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function rememberNightCode(sessionId: string, code: string): void {
  try {
    storage()?.setItem(PREFIX + sessionId, code);
  } catch {
    // Quota or disabled storage: the code is still on screen for now.
  }
}

export function recallNightCode(sessionId: string): string | null {
  try {
    return storage()?.getItem(PREFIX + sessionId) ?? null;
  } catch {
    return null;
  }
}

export function forgetNightCode(sessionId: string): void {
  try {
    storage()?.removeItem(PREFIX + sessionId);
  } catch {
    // Nothing to clean up.
  }
}

/** Night codes join only while a night is draft/voting/revealed/tonight (ADR-0002). */
export function nightCodeIsLive(status: string): boolean {
  return status === "draft" || status === "voting" || status === "revealed" || status === "tonight";
}
