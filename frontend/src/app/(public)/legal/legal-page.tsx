import Link from "next/link";

/** The shared frame of /legal/terms and /legal/privacy: a readable column, version on top. */
export function LegalPage({
  title,
  version,
  children,
}: {
  title: string;
  version: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-5 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground" data-testid="legal-version">
          Version {version}
        </p>
      </header>
      <div className="flex flex-col gap-5 leading-relaxed [&_h2]:font-heading [&_h2]:text-xl [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-1">
        {children}
      </div>
      <nav className="flex gap-4 border-t border-foreground/10 pt-4 text-sm">
        <Link className="underline" href="/legal/terms">
          Terms
        </Link>
        <Link className="underline" href="/legal/privacy">
          Privacy Policy
        </Link>
      </nav>
    </main>
  );
}
