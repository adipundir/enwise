import Link from "next/link";
import { auth } from "@/auth";
import { SiteHeader } from "@/components/site-header";

export default async function Home() {
  const session = await auth();
  const primaryHref = session ? "/dashboard" : "/signin";
  const primaryLabel = session ? "Open dashboard" : "Get started";

  return (
    <div className="flex flex-1 flex-col">
      <SiteHeader ctaHref={primaryHref} />

      <main className="flex flex-1 flex-col">
        <section className="mx-auto w-full max-w-6xl px-6 pt-24 pb-28 sm:pt-32 sm:pb-36">
          <h1 className="font-serif text-5xl leading-[1.05] sm:text-6xl md:text-7xl">
            <span className="text-zinc-100">Invoicing, by conversation.</span>
            <br />
            <span className="text-zinc-500">
              Tell Claude who to bill. It writes, sends, and tracks.
            </span>
          </h1>

          <p className="mt-10 max-w-2xl text-base leading-relaxed text-zinc-400">
            envoice is a Model Context Protocol server. Connect it once and run
            your entire invoicing business from inside Claude — clients,
            products, tax, multi-currency, sharable links, emailed PDFs. The web
            app exists for exactly one thing: creating an API key.
          </p>

          <div className="mt-10 flex flex-wrap items-center gap-3">
            <Link
              href={primaryHref}
              className="group inline-flex items-center gap-2 rounded-full bg-zinc-100 px-5 py-2.5 text-sm font-medium text-zinc-950 hover:bg-white"
            >
              {primaryLabel}
              <ArrowRight />
            </Link>
            <Link
              href="/#how"
              className="inline-flex items-center gap-2 rounded-full border border-zinc-800 px-5 py-2.5 text-sm text-zinc-200 hover:border-zinc-700 hover:bg-zinc-900"
            >
              <Dot /> How it works
            </Link>
            <a
              href="https://modelcontextprotocol.io"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-full border border-zinc-800 px-5 py-2.5 text-sm text-zinc-200 hover:border-zinc-700 hover:bg-zinc-900"
            >
              <Dot /> What is MCP
            </a>
          </div>
        </section>

        <section
          id="how"
          className="border-t border-zinc-900/80 bg-[#070707]"
        >
          <div className="mx-auto grid w-full max-w-6xl grid-cols-2 gap-px bg-zinc-900/80 px-6 sm:grid-cols-4">
            <Stat
              big="1"
              label="Web task"
              note="Generate an API key. Everything else is chat."
            />
            <Stat
              big="30+"
              label="MCP tools"
              note="Clients, products, invoices, recurring, analytics."
            />
            <Stat
              big="ISO 4217"
              label="Multi-currency"
              note="No FX. Just correct display and totals."
            />
            <Stat
              big="PDF"
              label="+ share link"
              note="Auto-generated for every invoice you create."
            />
          </div>
        </section>
      </main>

      <footer className="mx-auto w-full max-w-6xl px-6 py-10 text-xs text-zinc-600">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <span className="font-serif text-base text-zinc-400">envoice</span>
          <span>Invoicing from inside Claude. © {new Date().getFullYear()}.</span>
        </div>
      </footer>
    </div>
  );
}

function Stat({
  big,
  label,
  note,
}: {
  big: string;
  label: string;
  note: string;
}) {
  return (
    <div className="bg-[#070707] px-5 py-8 sm:px-6 sm:py-10">
      <div className="font-serif text-4xl text-zinc-100 sm:text-5xl">{big}</div>
      <div className="mt-3 text-sm text-zinc-300">{label}</div>
      <div className="mt-1 text-xs text-zinc-500">{note}</div>
    </div>
  );
}

function ArrowRight() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-4 transition-transform group-hover:translate-x-0.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M3 8h10m0 0-4-4m4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Dot() {
  return <span aria-hidden className="size-1.5 rounded-full bg-zinc-500" />;
}
