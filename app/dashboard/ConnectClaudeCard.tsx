"use client";

import Link from "next/link";
import { useState } from "react";

function buildPrompt(rawToken: string, mcpUrl: string): string {
  return `Add the enwise invoicing MCP server to Claude Code so it's available across all my projects. Run this:

claude mcp add --transport http --scope user enwise ${mcpUrl} --header "Authorization: Bearer ${rawToken}"

Then run \`claude mcp list\` to confirm it shows as Connected. To actually use the new tools, this Claude Code session needs to reload them. The reliable way is to exit (\`/exit\`) and restart Claude Code. After restart, call the \`whoami\` tool to verify everything works.`;
}

/**
 * Right-hand dashboard card. When the raw token is in hand (signup or just
 * after a rotation), the Copy button gives a one-shot Claude Code setup
 * prompt with the key embedded. Otherwise the button is disabled — the
 * raw key isn't stored, so the user has to rotate to mint a new one.
 */
export function ConnectClaudeCard({
  rawToken,
  mcpUrl,
}: {
  rawToken: string | null;
  mcpUrl: string;
}) {
  const [copied, setCopied] = useState(false);
  const ready = rawToken !== null;

  async function copyPrompt() {
    if (!rawToken) return;
    await navigator.clipboard.writeText(buildPrompt(rawToken, mcpUrl));
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="flex flex-col justify-between bg-[#0a0a0a] p-8">
      <div>
        <div className="text-xs font-mono uppercase tracking-widest text-zinc-600">
          02
        </div>
        <h2 className="mt-6 text-xl font-semibold tracking-tight text-zinc-100">
          Connect to Claude
        </h2>
        <p className="mt-3 max-w-md text-sm leading-relaxed text-zinc-400">
          {ready
            ? "Paste the prompt into Claude Code. Claude registers enwise globally and verifies the connection. Key is included."
            : "Paste the MCP server URL + bearer header into Claude Desktop or Claude.ai. Full instructions + config JSON on the next page."}
        </p>
        {ready ? null : (
          <p className="mt-3 max-w-md text-xs text-zinc-500">
            Your key was shown once at creation. Rotate it to mint a new one
            and copy a fresh setup prompt.
          </p>
        )}
      </div>
      <div className="mt-8 flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={copyPrompt}
          disabled={!ready}
          className="inline-flex items-center gap-2 rounded-md bg-zinc-100 px-3.5 py-2 text-xs font-medium text-zinc-950 hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
        >
          {ready
            ? copied
              ? "Copied — paste into Claude Code"
              : "Copy Claude Code prompt"
            : "Rotate key to copy"}
        </button>
        <Link
          href="/dashboard/connect"
          className="inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-100"
        >
          Other clients
          <svg
            viewBox="0 0 16 16"
            className="size-4"
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
        </Link>
      </div>
    </div>
  );
}
