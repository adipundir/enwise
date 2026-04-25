"use client";

import { useMemo, useState, useTransition } from "react";
import { regenerateKeyAction } from "./actions";

/** Full-width reveal banner. Shown only on first visit or right after regenerate. */
export function ApiKeyRevealCard({
  rawToken,
  mcpUrl,
}: {
  rawToken: string;
  mcpUrl: string;
}) {
  const [copiedToken, setCopiedToken] = useState(false);
  const [copiedConfig, setCopiedConfig] = useState(false);

  const configJson = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            enwise: {
              command: "npx",
              args: [
                "-y",
                "mcp-remote",
                mcpUrl,
                "--header",
                `Authorization: Bearer ${rawToken}`,
              ],
            },
          },
        },
        null,
        2,
      ),
    [mcpUrl, rawToken],
  );

  async function copy(value: string, setFlag: (b: boolean) => void) {
    await navigator.clipboard.writeText(value);
    setFlag(true);
    setTimeout(() => setFlag(false), 1800);
  }

  return (
    <section className="space-y-5 rounded-2xl border border-emerald-900/60 bg-emerald-950/20 p-6">
      <div className="space-y-1">
        <div className="inline-flex items-center gap-2 text-xs uppercase tracking-widest text-emerald-300">
          <span className="size-1.5 rounded-full bg-emerald-400" />
          Your API key
        </div>
        <h2 className="text-lg font-semibold tracking-tight text-zinc-100">
          Copy this once. You won&apos;t see it again.
        </h2>
      </div>

      <div className="flex items-center gap-2">
        <code className="flex-1 select-all break-all rounded-md border border-zinc-800 bg-[#0a0a0a] px-3 py-2 font-mono text-xs text-zinc-100">
          {rawToken}
        </code>
        <button
          type="button"
          onClick={() => copy(rawToken, setCopiedToken)}
          className="rounded-md bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-950 hover:bg-white"
        >
          {copiedToken ? "Copied" : "Copy key"}
        </button>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-widest text-zinc-500">
            Ready-to-paste Claude Desktop config
          </div>
          <button
            type="button"
            onClick={() => copy(configJson, setCopiedConfig)}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-100 hover:bg-zinc-800"
          >
            {copiedConfig ? "Copied" : "Copy JSON"}
          </button>
        </div>
        <pre className="overflow-auto rounded-md border border-zinc-800 bg-[#0a0a0a] p-4 font-mono text-[11px] leading-relaxed text-zinc-100">
          {configJson}
        </pre>
      </div>
    </section>
  );
}

/** Compact card for the masked/steady state. Pairs with the Connect Claude card. */
export function ApiKeyCard({ currentPrefix }: { currentPrefix: string | null }) {
  const [rawToken, setRawToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleRegenerate() {
    setConfirmOpen(false);
    startTransition(async () => {
      const result = await regenerateKeyAction();
      setRawToken(result.rawToken);
      setCopied(false);
    });
  }

  async function copyKey() {
    if (!rawToken) return;
    await navigator.clipboard.writeText(rawToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="flex flex-col justify-between bg-[#0a0a0a] p-8">
      <div>
        <div className="text-xs font-mono uppercase tracking-widest text-zinc-600">
          01
        </div>
        <h2 className="mt-6 text-xl font-semibold tracking-tight text-zinc-100">
          Your API key
        </h2>
        {rawToken ? (
          <div className="mt-4 space-y-3">
            <div className="flex items-center gap-2">
              <code className="flex-1 select-all break-all rounded-md border border-emerald-900/50 bg-emerald-950/20 px-3 py-2 font-mono text-xs text-zinc-100">
                {rawToken}
              </code>
              <button
                type="button"
                onClick={copyKey}
                className="rounded-md bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-950 hover:bg-white"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="text-xs text-emerald-300/80">
              Shown once. Copy it now.
            </p>
          </div>
        ) : (
          <div className="mt-4 flex items-center gap-3">
            <code className="font-mono text-sm text-zinc-200">
              {currentPrefix ? `${currentPrefix}…` : "—"}
            </code>
            <span className="text-[11px] text-zinc-600">hidden</span>
          </div>
        )}
      </div>

      <div className="mt-8 flex items-center gap-3">
        {!confirmOpen && !rawToken ? (
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={pending}
            className="text-sm text-zinc-400 hover:text-zinc-100 disabled:opacity-60"
          >
            Regenerate
          </button>
        ) : confirmOpen ? (
          <>
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              className="text-sm text-zinc-500 hover:text-zinc-200"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleRegenerate}
              disabled={pending}
              className="rounded-md bg-red-900/80 px-3 py-1.5 text-xs font-medium text-red-50 hover:bg-red-900 disabled:opacity-60"
            >
              {pending ? "Regenerating…" : "Confirm regenerate"}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
