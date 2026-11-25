// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { CalledBoard } from "./called-board";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(node: React.ReactNode): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("CalledBoard", () => {
  it("shows all 75 numbers and marks only the called ones", () => {
    const el = render(
      <CalledBoard
        variant="host"
        calls={[
          { seq: 0, value: 7, label: "B7" },
          { seq: 1, value: 52, label: "G52" },
        ]}
      />,
    );
    const cells = [...el.querySelectorAll<HTMLElement>("[data-testid=called-cell]")];
    expect(cells).toHaveLength(75);
    const called = cells.filter((c) => c.dataset.called === "true").map((c) => c.dataset.value);
    expect(called).toEqual(["7", "52"]);
    expect(el.querySelector("[data-value='7']")!.getAttribute("aria-label")).toBe("B7 called");
    expect(el.querySelector("[data-value='8']")!.getAttribute("aria-label")).toBe("B8 not called");
    expect(el.querySelector("[data-testid=bingo-called-board]")!.getAttribute("aria-label")).toBe(
      "Called numbers: 2 of 75",
    );
  });

  it("is empty before the first call", () => {
    const el = render(<CalledBoard variant="tv" calls={[]} />);
    expect(el.querySelectorAll("[data-called=true]")).toHaveLength(0);
  });
});
