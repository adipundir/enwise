import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { businesses } from "@/lib/db/schema";
import { auth } from "@/auth";

export default async function DashboardHome() {
  const session = await auth();
  const businessId = (session?.user as { defaultBusinessId?: string | null })
    ?.defaultBusinessId;

  const [business] = businessId
    ? await db.select().from(businesses).where(eq(businesses.id, businessId))
    : [];

  return (
    <div className="space-y-14">
      <section className="space-y-5">
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          Overview
        </div>
        <h1 className="display text-3xl leading-tight sm:text-4xl">
          <span className="text-zinc-100">
            Welcome
            {session?.user?.name
              ? `, ${session.user.name.split(" ")[0]}`
              : ""}.
          </span>
          <br />
          <span className="text-zinc-500">
            Your invoicing business lives in Claude from here.
          </span>
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">
          Business profile:{" "}
          <span className="text-zinc-200">
            {business?.name ?? "(setting up…)"}
          </span>
          . Edit it, add clients, create invoices, and send PDFs — all via
          natural language once Claude is connected.
        </p>
      </section>

      <section className="grid gap-px bg-zinc-900 sm:grid-cols-2">
        <DashboardCard
          href="/dashboard/api-tokens"
          index="01"
          title="Create an API token"
          description="Generate a bearer token so Claude can talk to your envoice MCP server."
        />
        <DashboardCard
          href="/dashboard/connect"
          index="02"
          title="Connect to Claude"
          description="Paste the MCP server config into Claude Desktop or Claude.ai and you're live."
        />
      </section>
    </div>
  );
}

function DashboardCard({
  href,
  index,
  title,
  description,
}: {
  href: string;
  index: string;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col justify-between bg-[#0a0a0a] p-8 transition-colors hover:bg-[#0d0d0d]"
    >
      <div>
        <div className="text-xs font-mono uppercase tracking-widest text-zinc-600">
          {index}
        </div>
        <h2 className="mt-6 text-xl font-semibold tracking-tight text-zinc-100">
          {title}
        </h2>
        <p className="mt-3 max-w-md text-sm leading-relaxed text-zinc-400">
          {description}
        </p>
      </div>
      <div className="mt-10 inline-flex items-center gap-2 text-sm text-zinc-300 group-hover:text-zinc-100">
        Continue
        <svg
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
      </div>
    </Link>
  );
}
