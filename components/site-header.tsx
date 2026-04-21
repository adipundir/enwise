import Link from "next/link";

export function SiteHeader({ ctaHref = "/signin" }: { ctaHref?: string }) {
  return (
    <header className="w-full">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Link
          href="/"
          className="font-serif text-xl tracking-tight text-zinc-100"
        >
          envoice
        </Link>
        <nav className="flex items-center gap-6 text-sm text-zinc-400">
          <a
            href="https://modelcontextprotocol.io"
            target="_blank"
            rel="noreferrer"
            className="hidden sm:inline hover:text-zinc-100"
          >
            MCP
          </a>
          <Link
            href="/#how"
            className="hidden sm:inline hover:text-zinc-100"
          >
            How it works
          </Link>
          <Link
            href={ctaHref}
            className="rounded-md border border-zinc-800 bg-zinc-900 px-3.5 py-1.5 text-zinc-100 hover:border-zinc-700 hover:bg-zinc-800"
          >
            Sign in
          </Link>
        </nav>
      </div>
    </header>
  );
}
