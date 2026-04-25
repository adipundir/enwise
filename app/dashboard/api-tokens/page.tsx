import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { listTokens } from "@/lib/tokens";
import { revokeTokenAction } from "./actions";
import { CreateTokenForm } from "./CreateTokenForm";

export default async function ApiTokensPage() {
  const session = await auth();
  const businessId = (session?.user as { defaultBusinessId?: string | null })
    ?.defaultBusinessId;

  if (!businessId) {
    redirect("/signin?callbackUrl=/dashboard/api-tokens");
  }

  const tokens = await listTokens(businessId);

  return (
    <div className="space-y-10">
      <div className="space-y-2">
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          Settings
        </div>
        <h1 className="font-serif text-4xl text-zinc-100">API tokens</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">
          Bearer tokens used by Claude to authenticate with your envoice MCP
          server. Tokens are shown once at creation — copy and paste them into
          your Claude client, then store them somewhere safe.
        </p>
      </div>

      <section className="rounded-2xl border border-zinc-900 bg-[#0c0c0c] p-6">
        <h2 className="font-serif text-lg text-zinc-100">Create a token</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Name it after where it'll live (e.g. "Claude Desktop — personal").
        </p>
        <div className="mt-5">
          <CreateTokenForm />
        </div>
      </section>

      <section>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="font-serif text-lg text-zinc-100">Your tokens</h2>
          <span className="text-xs text-zinc-600">
            {tokens.length} total
          </span>
        </div>
        {tokens.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 bg-[#0c0c0c] p-8 text-center text-sm text-zinc-500">
            No tokens yet. Create one above.
          </div>
        ) : (
          <div className="divide-y divide-zinc-900 overflow-hidden rounded-xl border border-zinc-900">
            {tokens.map((t) => (
              <div
                key={t.id}
                className="flex flex-wrap items-center gap-4 bg-[#0a0a0a] px-5 py-4"
              >
                <div className="flex-1 min-w-[200px] space-y-1">
                  <div className="flex items-center gap-2 text-sm text-zinc-100">
                    <span>{t.name}</span>
                    {t.revokedAt && (
                      <span className="rounded-full border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[10px] uppercase tracking-widest text-zinc-500">
                        Revoked
                      </span>
                    )}
                  </div>
                  <div className="font-mono text-xs text-zinc-500">
                    {t.tokenPrefix}…
                  </div>
                </div>
                <div className="text-xs text-zinc-500">
                  {t.lastUsedAt
                    ? `Used ${formatRelative(t.lastUsedAt)}`
                    : "Never used"}
                </div>
                <div className="text-xs text-zinc-500">
                  Created {formatRelative(t.createdAt)}
                </div>
                {!t.revokedAt && (
                  <form action={revokeTokenAction}>
                    <input type="hidden" name="tokenId" value={t.id} />
                    <button
                      type="submit"
                      className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-300 hover:border-red-900/60 hover:text-red-300"
                    >
                      Revoke
                    </button>
                  </form>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function formatRelative(date: Date | string | null): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  const diff = Date.now() - d.getTime();
  const secs = Math.round(diff / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}yr ago`;
}
