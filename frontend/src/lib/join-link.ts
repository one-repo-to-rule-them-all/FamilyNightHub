import { create } from "qrcode";

/** The fridge/TV QR's target: the household's join door (ADR-0002). A door, not a key. */
export function joinUrl(origin: string, slug: string): string {
  return `${origin.replace(/\/+$/, "")}/j/${encodeURIComponent(slug)}`;
}

export type QrShape = { size: number; path: string };

/**
 * The QR for `text` as one SVG path (one 1×1 square per dark module), drawn by the caller in a
 * `viewBox` of `size` plus a quiet zone. Rendered as SVG, not innerHTML, so nothing is injected.
 */
export function qrShape(text: string): QrShape {
  const { modules } = create(text, { errorCorrectionLevel: "M" });
  const { size } = modules;
  let path = "";
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (modules.get(row, col)) path += `M${col} ${row}h1v1h-1z`;
    }
  }
  return { size, path };
}
