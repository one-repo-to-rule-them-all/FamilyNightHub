"use client";

import { useEffect, useId, useRef } from "react";

import { cn } from "@/lib/utils";

/**
 * A native modal `<dialog>` (as PhotoViewer uses): focus stays inside, Escape closes, the page
 * behind is inert. Mounted only while open, so its contents start fresh each time; the caller
 * unmounts it from `onClose`.
 */
export function ModalDialog({
  title,
  children,
  onClose,
  className,
  testId,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
  onClose: () => void;
  className?: string;
  testId?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      data-testid={testId}
      className={cn(
        "m-auto w-[min(32rem,calc(100vw-2rem))] rounded-2xl bg-popover p-0 text-popover-foreground ring-1 ring-foreground/10 backdrop:bg-black/70",
        className,
      )}
    >
      <div className="flex flex-col gap-4 p-5">
        <h2 id={titleId} className="text-xl font-semibold">
          {title}
        </h2>
        {children}
      </div>
    </dialog>
  );
}
