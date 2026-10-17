import { create } from "qrcode";

import { completeNightCode } from "@/lib/night-code";

/** The fridge/TV QR's target: the household's join door (ADR-0002). A door, not a key. */
export function joinUrl(origin: string, slug: string): string {
  return `${origin.replace(/\/+$/, "")}/j/${encodeURIComponent(slug)}`;
}

/**
 * The TV QR's target (guest-flow spec §5 TV, owner decision §10.1). The door `/j/{slug}` by
 * default; `/j/{slug}?code=…` only when the household turned on "Include tonight's code in the TV
 * QR" and this TV holds tonight's code (the server never returns it, ADR-0002).
 */
export function tvJoinUrl(
  origin: string,
  slug: string,
  code: string | null,
  includeCode: boolean,
): string {
  const door = joinUrl(origin, slug);
  const clean = code ? completeNightCode(code) : null;
  if (!includeCode || !clean) return door;
  return `${door}?${new URLSearchParams({ code: clean }).toString()}`;
}

/**
 * The night code a TV QR put in the join URL, cleaned, or null when there is none or it can't be
 * one (look-alike characters, wrong length): then the field just stays empty (spec AC-1.1b).
 */
export function codeFromQuery(search: string | URLSearchParams): string | null {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const raw = params.get("code");
  return raw ? completeNightCode(raw) : null;
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
