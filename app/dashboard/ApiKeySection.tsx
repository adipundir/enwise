"use client";

import { useMemo, useState, useTransition } from "react";
import { regenerateKeyAction } from "./actions";

export function ApiKeySection({
  initialRawToken,
  currentPrefix,
  mcpUrl,
}: {
  initialRawToken: string | null;
  currentPrefix: string | null;
  mcpUrl: string;
}) {
  const [rawToken, setRawToken] = useState<string | null>(initialRawToken);
  const [pending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);
  const [copiedConfig, setCopiedConfig] = useState(false);

  const configJson = useMemo(() => {
    const keyForConfig = rawToken ?? "<YOUR_TOKEN>";
    return JSON.stringify(
      {
        mcpServers: {
          envoice: {
            command: "npx",
            args: [
              "-y",
              "mcp-remote",
              mcpUrl,
              "--header",
              `Authorization: Bearer ${keyForConfig}`,
            ],
          },
        },
      },
      null,
      2,
    );
  }, [mcpUrl, rawToken]);

  async function copy(value: string, setFlag: (b: boolean) => void) {
    await navigator.clipboard.writeText(value);
    setFlag(true);
    setTimeout(() => setFlag(false), 1800);
  }

  function handleRegenerate() {
    setConfirmOpen(false);
    startTransition(async () => {
      const result = await regenerateKeyAction();
      setRawToken(result.rawToken);
      setCopiedToken(false);
    });
  }

  // ---- Raw token visible: first-visit bootstrap, or freshly regenerated ----
  if (rawToken) {
    return (
      <section className="space-y-5 rounded-2xl border border-emerald-900/60 bg-emerald-950/20 p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="inline-flex items-center gap-2 text-xs uppercase tracking-widest text-emerald-300">
              <span className="size-1.5 rounded-full bg-emerald-400" />
              Your API key
            </div>
            <h2 className="text-lg font-semibold tracking-tight text-zinc-100">
              Copy this once. You won&apos;t see it again.
            </h2>
            <p className="text-sm text-zinc-400">
              Refresh this page and it&apos;s gone. Regenerate if you lose it.
            </p>
          </div>
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
          <p className="text-xs text-zinc-500">
            Append to{" "}
            <code className="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px]">
              ~/Library/Application Support/Claude/claude_desktop_config.json
            </code>
            , then restart Claude Desktop. Or paste the URL + bearer header
            into Claude.ai → Connectors → Add custom connector.
          </p>
        </div>
      </section>
    );
  }

  // ---- Masked view: token exists, raw not available (revisits) ----
  return (
    <section className="space-y-5 rounded-2xl border border-zinc-900 bg-[#0c0c0c] p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="text-xs uppercase tracking-widest text-zinc-500">
            Your API key
          </div>
          <div className="font-mono text-sm text-zinc-100">
            {currentPrefix ? `${currentPrefix}…` : "—"}{" "}
            <span className="text-zinc-600">(hidden)</span>
          </div>
          <p className="text-xs text-zinc-500">
            We only show the full key at creation. Regenerate below to get a
            new one — this invalidates the old key everywhere it&apos;s
            installed.
          </p>
        </div>
        {!confirmOpen ? (
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={pending}
            className="rounded-md border border-zinc-800 bg-zinc-900 px-3.5 py-1.5 text-sm text-zinc-100 hover:border-zinc-700 hover:bg-zinc-800 disabled:opacity-60"
          >
            {pending ? "Regenerating…" : "Regenerate"}
          </button>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-zinc-400">
              This will revoke your current key.
            </span>
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
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
          </div>
        )}
      </div>

      <details className="group">
        <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">
          Show Claude Desktop config template
        </summary>
        <pre className="mt-3 overflow-auto rounded-md border border-zinc-800 bg-[#0a0a0a] p-4 font-mono text-[11px] leading-relaxed text-zinc-100">
          {configJson}
        </pre>
        <p className="mt-2 text-xs text-zinc-500">
          Replace{" "}
          <code className="rounded bg-zinc-900 px-1 py-0.5 text-[10px]">
            &lt;YOUR_TOKEN&gt;
          </code>{" "}
          with your key.
        </p>
      </details>
    </section>
  );
}
