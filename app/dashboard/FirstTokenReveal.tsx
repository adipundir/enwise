"use client";

import { useMemo, useState } from "react";

export function FirstTokenReveal({
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
            envoice: {
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
        <p className="text-sm text-zinc-400">
          Refresh this page and it&apos;s gone. You can generate a new one from
          the API tokens page anytime.
        </p>
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
          , then restart Claude Desktop. Or paste the URL + bearer header into
          Claude.ai → Connectors → Add custom connector.
        </p>
      </div>
    </section>
  );
}
