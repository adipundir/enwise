"use client";

import { useMemo, useState } from "react";

/**
 * Claude Code one-prompt setup. User pastes their API key; the prompt below
 * is built client-side with the key embedded and copied with one click. The
 * key never leaves the browser — we don't persist raw tokens.
 */
export function ClaudeCodeSetup({ mcpUrl }: { mcpUrl: string }) {
  const [token, setToken] = useState("");
  const [copied, setCopied] = useState(false);

  const trimmed = token.trim();
  const tokenForPrompt = trimmed || "<YOUR_TOKEN>";

  const prompt = useMemo(
    () =>
      `Register the enwise invoicing MCP server for me. Run:

claude mcp add --transport http --scope user enwise ${mcpUrl} --header "Authorization: Bearer ${tokenForPrompt}"

Then \`claude mcp list\` should show enwise as Connected. Claude Code loads MCP tools at session start, so the tools aren't usable in this session. Tell me to \`/exit\` and relaunch Claude Code — in the next session, call the \`whoami\` tool and it'll walk us through setting up my business profile and first client.`,
    [mcpUrl, tokenForPrompt],
  );

  async function copy() {
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  const ready = trimmed.length > 0;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label
          htmlFor="paste-key"
          className="text-xs uppercase tracking-widest text-zinc-500"
        >
          Paste your API key
        </label>
        <input
          id="paste-key"
          type="text"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="env_live_…"
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-md border border-zinc-800 bg-[#0a0a0a] px-3 py-2 font-mono text-xs text-zinc-100 placeholder:text-zinc-700 focus:border-zinc-600 focus:outline-none"
        />
        <p className="text-xs text-zinc-600">
          Stays in your browser. Never sent to enwise.
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs uppercase tracking-widest text-zinc-500">
            Paste this into Claude Code
          </div>
          <button
            type="button"
            onClick={copy}
            disabled={!ready}
            className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-100 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {copied ? "Copied" : ready ? "Copy prompt" : "Paste key first"}
          </button>
        </div>
        <pre
          className={`overflow-auto rounded-md border border-zinc-800 bg-[#0a0a0a] p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap ${
            ready ? "text-zinc-100" : "text-zinc-500"
          }`}
        >
          {prompt}
        </pre>
      </div>
    </div>
  );
}
