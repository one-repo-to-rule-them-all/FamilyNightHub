/**
 * Night-code entry, mirroring backend app/domain/night_code.py (ADR-0002).
 *
 * The server is the authority (it normalizes again and only compares hashes). This only makes the
 * field forgiving: lower case, spaces, dashes and pasted junk are cleaned as you type, and the
 * button enables once six characters from the TV alphabet are in.
 */

/** No 0/O, 1/I/L, so a code read off a TV across the room can't be misread. */
export const NIGHT_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const NIGHT_CODE_LENGTH = 6;

/** What the field shows: upper case, letters and digits only, at most six of them. */
export function cleanNightCodeInput(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, NIGHT_CODE_LENGTH);
}

/** Characters the TV never shows (someone read an O for a 0, or an I for a 1). */
export function lookalikes(code: string): string[] {
  return [...new Set([...code].filter((ch) => !NIGHT_CODE_ALPHABET.includes(ch)))];
}

/** The canonical code to send, or null while it cannot be one yet. */
export function completeNightCode(raw: string): string | null {
  const code = cleanNightCodeInput(raw);
  if (code.length !== NIGHT_CODE_LENGTH || lookalikes(code).length > 0) return null;
  return code;
}
