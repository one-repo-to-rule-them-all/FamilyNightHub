/**
 * A screen's heading inside `GuestShell` (which owns the `<main>`): the same title and lede as
 * `PhoneScreen`'s header, so night screens look the same with or without the shell.
 */
export function ScreenTitle({ title, lede }: { title: React.ReactNode; lede?: React.ReactNode }) {
  return (
    <header className="flex flex-col gap-2">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">{title}</h1>
      {lede ? <p className="text-lg text-muted-foreground">{lede}</p> : null}
    </header>
  );
}
