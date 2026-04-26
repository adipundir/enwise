import Link from "next/link";

export function SiteHeader({
  ctaHref = "/signin",
  ctaLabel,
}: {
  ctaHref?: string;
  ctaLabel?: string;
}) {
  const label =
    ctaLabel ?? (ctaHref === "/dashboard" ? "Dashboard" : "Sign in");
  return (
    <header className="w-full">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6 sm:py-5">
        <Link
          href="/"
          className="text-base font-semibold tracking-tight text-zinc-100"
        >
          enwise
        </Link>
        <nav className="flex items-center gap-6 text-sm text-zinc-400">
          <Link
            href="/#how"
            className="hidden sm:inline hover:text-zinc-100"
          >
            How it works
          </Link>
          <Link
            href="/#pricing"
            className="hidden sm:inline hover:text-zinc-100"
          >
            Pricing
          </Link>
          <Link
            href="/docs/setup"
            className="hidden sm:inline hover:text-zinc-100"
          >
            Setup
          </Link>
          <Link
            href={ctaHref}
            className="rounded-md border border-zinc-800 bg-zinc-900 px-3.5 py-1.5 text-zinc-100 hover:border-zinc-700 hover:bg-zinc-800"
          >
            {label}
          </Link>
        </nav>
      </div>
    </header>
  );
}
