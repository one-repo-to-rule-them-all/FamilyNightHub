// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Photo } from "@/lib/api";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<"a">) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { PhotoStripView } = await import("./photo-strip");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const night = {
  id: "n1",
  title: null,
  winner: { option_id: "o1", movie_id: "m1", title: "Paddington 2", poster_path: null, year: null },
};
const photo = (i: number, status: Photo["status"] = "ready") => ({
  id: `p${i}`,
  thumb_url: `https://img/${i}`,
  status,
});

describe("PhotoStripView (§5 H1 item 5)", () => {
  it("shows up to four ready photos from the night, opening its album", () => {
    act(() =>
      root.render(<PhotoStripView night={night} photos={[1, 2, 3, 4, 5].map((i) => photo(i))} />),
    );
    expect(host.textContent).toContain("Family photos from Paddington 2");
    expect(host.querySelectorAll("img")).toHaveLength(4);
    expect(host.querySelector("a")?.getAttribute("href")).toBe("/albums/n1");
  });

  it("is hidden when the night has no ready photos", () => {
    act(() => root.render(<PhotoStripView night={night} photos={[photo(1, "hidden")]} />));
    expect(host.querySelector('[data-testid="photo-strip"]')).toBeNull();
    act(() => root.render(<PhotoStripView night={night} photos={[]} />));
    expect(host.innerHTML).toBe("");
  });
});
