import Link from "next/link";
import { auth } from "@/auth";
import { RotatingWord } from "@/components/rotating-word";
import { SiteHeader } from "@/components/site-header";

export async function Landing() {
  const session = await auth();
  const primaryHref = session ? "/dashboard" : "/signin";
  const primaryLabel = session ? "Open dashboard" : "Get started";

  return (
    <div className="flex flex-1 flex-col">
      <SiteHeader ctaHref={primaryHref} />

      <main className="flex flex-1 flex-col">
        {/* Hero */}
        <section className="mx-auto w-full max-w-6xl px-6 pt-24 pb-20 sm:pt-32">
          <h1 className="display text-4xl leading-[1.05] sm:text-5xl md:text-6xl">
            <span className="font-bold text-zinc-100">
              Create invoices with AI.
            </span>
            <br />
            <span className="font-normal text-zinc-500">
              Bill clients, send PDFs, and track payments by chatting with{" "}
              <RotatingWord
                words={["Claude", "Cursor", "Codex", "Windsurf", "Antigravity"]}
                className="text-zinc-200"
              />
            </span>
          </h1>
          <p className="mt-8 max-w-xl text-sm leading-relaxed text-zinc-400">
            enwise plugs into your AI over the Model Context Protocol. Tell it
            who to bill and what for. It creates the invoice, renders the PDF,
            emails the client a link, and records the payment when it comes
            in.
          </p>

          <div className="mt-10 flex flex-wrap items-center gap-3">
            <Link
              href={primaryHref}
              className="group inline-flex items-center gap-2 rounded-md bg-zinc-100 px-5 py-2.5 text-sm font-medium text-zinc-950 hover:bg-white"
            >
              {primaryLabel}
              <ArrowRight />
            </Link>
            <Link
              href="#how"
              className="inline-flex items-center gap-2 rounded-md border border-zinc-800 px-5 py-2.5 text-sm text-zinc-200 hover:border-zinc-700 hover:bg-zinc-900"
            >
              <Dot /> How it works
            </Link>
          </div>
        </section>

        {/* How it works */}
        <section id="how" className="border-t border-zinc-900">
          <div className="mx-auto w-full max-w-6xl px-6 py-16 sm:py-20">
            <div className="text-[11px] uppercase tracking-widest text-zinc-500">
              How it works
            </div>
            <h2 className="mt-3 display text-2xl leading-tight sm:text-3xl text-zinc-100">
              Three steps. You&apos;re done in under two minutes.
            </h2>

            <div className="mt-10 grid gap-px bg-zinc-900 sm:grid-cols-3">
              <Step
                n="01"
                title="Sign in"
                body="Sign in with GitHub or Google. Your API key is minted and shown once."
              />
              <Step
                n="02"
                title="Connect your AI"
                body="One-shot copy-paste for Claude Code. Or drop the URL + bearer into Cursor, Claude.ai, Windsurf, and other MCP clients."
              />
              <Step
                n="03"
                title="Just ask"
                body="Type what you want to bill. Your AI does the rest. PDF, email, share link, tracking."
              />
            </div>
          </div>
        </section>

        {/* Capabilities */}
        <section className="border-t border-zinc-900">
          <div className="mx-auto w-full max-w-6xl px-6 py-16 sm:py-20">
            <div className="text-[11px] uppercase tracking-widest text-zinc-500">
              What&apos;s included
            </div>
            <h2 className="mt-3 display text-2xl leading-tight sm:text-3xl text-zinc-100">
              The full billing surface, exposed as MCP tools.
            </h2>

            <div className="mt-10 grid grid-cols-2 gap-px bg-zinc-900 sm:grid-cols-4">
              <Stat
                big="Clients"
                label="Contacts with addresses, tax IDs, default currency."
              />
              <Stat
                big="Invoices"
                label="Per-line tax, multi-currency, PDF, share link."
              />
              <Stat
                big="Email"
                label="Sends the client a link to the hosted invoice in one tool call."
              />
              <Stat
                big="Recurring"
                label="Monthly / quarterly / yearly. Runs daily at 09:00 UTC."
              />
              <Stat
                big="Products"
                label="Reusable line items with SKUs and default tax rates."
              />
              <Stat
                big="Analytics"
                label="Client summaries, revenue by period, outstanding totals."
              />
              <Stat
                big="Share links"
                label="Public /i/[slug] page with downloadable PDF."
              />
              <Stat
                big="Fuzzy search"
                label="“Send to Acme” resolves via pg_trgm automatically."
              />
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="border-t border-zinc-900 bg-[#070707]">
          <div className="mx-auto w-full max-w-3xl px-6 py-20 sm:py-24">
            <div className="text-[11px] uppercase tracking-widest text-zinc-500">
              Pricing
            </div>
            <h2 className="mt-3 display text-2xl leading-tight sm:text-3xl text-zinc-100">
              Free. Every feature. No tiers, no caps.
            </h2>

            <div className="mt-10">
              <div className="flex flex-col rounded-2xl border border-zinc-200 bg-zinc-50 p-8 text-zinc-900">
                <div className="text-[11px] uppercase tracking-widest text-zinc-500">
                  All accounts
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="display text-4xl text-zinc-900">$0</span>
                </div>
                <p className="mt-3 text-sm text-zinc-600">
                  Everything unlocked from day one. No upsell, no metering.
                </p>
                <ul className="mt-6 space-y-2.5 text-sm text-zinc-700">
                  <LiDark>Unlimited businesses, clients, invoices</LiDark>
                  <LiDark>Email delivery, share links, hosted PDFs</LiDark>
                  <LiDark>Recurring invoices + auto-send</LiDark>
                  <LiDark>Custom brand color + logo on PDFs</LiDark>
                  <LiDark>Up to 10 attachments per line item, 10 MB each</LiDark>
                </ul>
                <Link
                  href={primaryHref}
                  className="mt-8 inline-flex items-center justify-center gap-2 self-start rounded-md bg-zinc-900 px-5 py-2.5 text-sm font-medium text-zinc-50 hover:bg-black"
                >
                  Get started
                  <ArrowRight />
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-zinc-900">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-8 text-xs text-zinc-600">
          <span className="text-base font-semibold text-zinc-400">enwise</span>
          <span>
            Invoicing from inside Claude. © {new Date().getFullYear()}.
          </span>
        </div>
      </footer>
    </div>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="bg-[#0a0a0a] px-6 py-8">
      <div className="font-mono text-xs uppercase tracking-widest text-zinc-600">
        {n}
      </div>
      <div className="mt-4 text-base font-semibold tracking-tight text-zinc-100">
        {title}
      </div>
      <div className="mt-2 text-sm leading-relaxed text-zinc-400">{body}</div>
    </div>
  );
}

function Stat({ big, label }: { big: string; label: string }) {
  return (
    <div className="bg-[#0a0a0a] px-6 py-8">
      <div className="text-base font-semibold tracking-tight text-zinc-100">
        {big}
      </div>
      <div className="mt-2 text-sm leading-relaxed text-zinc-500">{label}</div>
    </div>
  );
}

function LiDark({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <svg
        viewBox="0 0 16 16"
        className="mt-1 size-3.5 shrink-0 text-zinc-900"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M3 8l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>{children}</span>
    </li>
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
      <path
        d="M3 8h10m0 0-4-4m4 4-4 4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Dot() {
  return <span aria-hidden className="size-1.5 rounded-full bg-zinc-500" />;
}
