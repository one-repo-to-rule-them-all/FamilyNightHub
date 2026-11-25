"use client";

import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { fitScale } from "@/lib/game-layout";

/**
 * The TV frame's stage: centres its content in the height the frame leaves and shrinks it to fit
 * when a crowd (a long strip, a big board) leaves less room than the content wants. A TV cannot
 * scroll, so before this a 12-player bingo board lost its last rows off the bottom.
 */
export function FitStage({ children }: { children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i) return;
    const measure = () =>
      setScale(
        fitScale(
          { width: o.clientWidth, height: o.clientHeight },
          { width: i.offsetWidth, height: i.offsetHeight },
        ),
      );
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(o);
    ro.observe(i);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={outer}
      className="relative min-h-0 flex-1 overflow-hidden"
      data-testid="game-stage"
      data-scale={scale.toFixed(2)}
    >
      <div
        ref={inner}
        className="absolute inset-x-0 top-1/2 flex w-full flex-col items-center gap-[1.25em] py-[0.25em]"
        style={{ transform: `translateY(-50%) scale(${scale})`, transformOrigin: "center" }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The TV frame's banner (win announcements): its own height, but never more than `maxFraction` of
 * the frame, shrinking its text to fit. Five winners' names in a banner used to push the player
 * strip off the bottom of the screen.
 */
export function FitBanner({
  children,
  maxFraction = 0.4,
}: {
  children: ReactNode;
  maxFraction?: number;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ scale: number; height?: number }>({ scale: 1 });

  useLayoutEffect(() => {
    const w = wrap.current;
    const i = inner.current;
    const frame = w?.parentElement;
    if (!w || !i || !frame) return;
    const measure = () => {
      const natural = i.offsetHeight;
      const scale = fitScale(
        { width: w.clientWidth, height: frame.clientHeight * maxFraction },
        { width: i.offsetWidth, height: natural },
        0.45,
      );
      setFit(scale === 1 ? { scale } : { scale, height: natural * scale });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(frame);
    ro.observe(i);
    return () => ro.disconnect();
  }, [maxFraction]);

  return (
    <div
      ref={wrap}
      className="shrink-0 overflow-hidden"
      style={fit.height === undefined ? undefined : { height: fit.height }}
      data-scale={fit.scale.toFixed(2)}
    >
      <div ref={inner} style={{ transform: `scale(${fit.scale})`, transformOrigin: "top center" }}>
        {children}
      </div>
    </div>
  );
}
