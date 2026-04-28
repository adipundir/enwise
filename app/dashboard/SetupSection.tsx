"use client";

import { useEffect, useRef, useState } from "react";

type AgentId = "claude-code" | "claude-ai" | "cursor" | "codex" | "windsurf";

interface AgentMeta {
  id: AgentId;
  label: string;
}

const AGENTS: AgentMeta[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "claude-ai", label: "Claude.ai" },
  { id: "cursor", label: "Cursor" },
  { id: "codex", label: "Codex" },
  { id: "windsurf", label: "Windsurf" },
];

function buildClaudeCodeCommands(
  rawToken: string,
  mcpUrl: string,
): { remove: string; add: string; restart: string; firstPrompt: string } {
  // The `add` command is chained with a silent `remove` first so it works in
  // both cases:
  //   - First-time install: remove exits 1 ("No user-scoped MCP server
  //     found"), 2>/dev/null swallows it, add proceeds.
  //   - Re-install / regenerate: remove cleans up the stale registration
  //     (which would otherwise make `claude mcp add` a no-op and leave the
  //     old token in ~/.claude.json), then add registers fresh.
  // `;` not `&&` — we want add to run regardless of remove's exit code.
  const removeCmd = `claude mcp remove enwise -s user 2>/dev/null`;
  const addCmd = `claude mcp add --transport http --scope user enwise ${mcpUrl} --header "Authorization: Bearer ${rawToken}"`;
  return {
    remove: `claude mcp remove enwise -s user`,
    add: `${removeCmd}; ${addCmd}`,
    restart: `/exit\nclaude`,
    firstPrompt: `Use whoami to show my enwise account, then walk me through setting up my business profile and first client.`,
  };
}

/** What the "Generate key" button copies to the clipboard for claude-code:
 *  the install command with the freshly-minted token already embedded. */
function buildClaudeCodeInstall(rawToken: string, mcpUrl: string): string {
  return buildClaudeCodeCommands(rawToken, mcpUrl).add;
}

function buildJsonConfig(rawToken: string, mcpUrl: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        enwise: {
          url: mcpUrl,
          headers: { Authorization: `Bearer ${rawToken}` },
        },
      },
    },
    null,
    2,
  );
}

function buildWindsurfConfig(rawToken: string, mcpUrl: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        enwise: {
          serverUrl: mcpUrl,
          headers: { Authorization: `Bearer ${rawToken}` },
        },
      },
    },
    null,
    2,
  );
}

function buildCodexConfig(rawToken: string, mcpUrl: string): string {
  return `[mcp_servers.enwise]
url = "${mcpUrl}"
http_headers = { Authorization = "Bearer ${rawToken}" }`;
}

/**
 * Setup flow with a per-agent dropdown. Each agent has its own three
 * step layout: configure, restart/reload, verify. Tokens are minted on
 * signup (auth.ts) and never rotated — users only ever see their actual
 * key embedded in the install command.
 */
export function SetupSection({
  initialRawToken,
  mcpUrl,
  hasInvoices,
}: {
  initialRawToken: string | null;
  mcpUrl: string;
  hasInvoices: boolean;
}) {
  const [agent, setAgent] = useState<AgentId>("claude-code");
  // Once the user has at least one invoice, the setup steps are noise on
  // every dashboard visit. Collapse by default; user can re-open to switch
  // agent or grab the install command again.
  const [expanded, setExpanded] = useState(!hasInvoices);

  const rawToken = initialRawToken;

  function payloadFor(token: string): string {
    switch (agent) {
      case "claude-code":
        return buildClaudeCodeInstall(token, mcpUrl);
      case "claude-ai":
        return `Authorization: Bearer ${token}`;
      case "windsurf":
        return buildWindsurfConfig(token, mcpUrl);
      case "codex":
        return buildCodexConfig(token, mcpUrl);
      case "cursor":
        return buildJsonConfig(token, mcpUrl);
    }
  }

  const primaryLabel =
    agent === "claude-ai"
      ? "Copy bearer header"
      : agent === "codex"
        ? "Copy TOML config"
        : agent === "cursor" || agent === "windsurf"
          ? "Copy JSON config"
          : "Copy install command";

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-zinc-100">
            Set up enwise
          </h2>
          <p className="mt-1 text-sm text-zinc-400">
            {expanded
              ? "Three steps. You only need to do this once."
              : "Already connected. Open to switch agents or get a fresh setup payload."}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {expanded ? (
            <AgentPicker value={agent} onChange={setAgent} />
          ) : null}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100 focus:outline-none"
            aria-expanded={expanded}
          >
            {expanded ? "Hide" : "Show"}
            <svg
              viewBox="0 0 16 16"
              className={`size-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
            >
              <path
                d="M4 6l4 4 4-4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>

      {!expanded ? null : agent === "claude-code" ? (
        <ClaudeCodeSteps rawToken={rawToken} mcpUrl={mcpUrl} />
      ) : (
      <div className="grid gap-px overflow-hidden rounded-xl border border-zinc-900 bg-zinc-900 md:grid-cols-3">
        {/* STEP 1 */}
        <div className="flex flex-col bg-[#0a0a0a] p-6 sm:p-8">
          <StepKicker n="01" title="Copy the config" />
          <p className="mt-4 text-sm leading-relaxed text-zinc-400">
            {step1Body(agent)}
          </p>
          <div className="mt-auto pt-8">
            <CopyButton
              command={payloadFor(rawToken ?? "")}
              label={primaryLabel}
              copiedLabel={primaryLabel.replace(/^Copy/, "Copied")}
            />
          </div>
        </div>

        {/* STEP 2 */}
        <div className="flex flex-col bg-[#0a0a0a] p-6 sm:p-8">
          <StepKicker n="02" title={step2Title(agent)} />
          <p className="mt-4 text-sm leading-relaxed text-zinc-400">
            {step2Body(agent)}
          </p>
          {step2Code(agent) ? (
            <div className="mt-auto pt-8 space-y-3">
              <div className="rounded-md border border-zinc-800 bg-[#070707] p-3 font-mono text-xs text-zinc-300">
                {step2Code(agent)!.split("\n").map((line, i) => (
                  <div key={i} className={i > 0 ? "mt-1" : ""}>
                    <span className="text-zinc-600">$</span> {line}
                  </div>
                ))}
              </div>
              <p className="text-xs leading-relaxed text-zinc-500">
                {step2Hint(agent)}
              </p>
            </div>
          ) : null}
        </div>

        {/* STEP 3 */}
        <div className="flex flex-col bg-[#0a0a0a] p-6 sm:p-8">
          <StepKicker n="03" title="Verify it works" />
          <p className="mt-4 text-sm leading-relaxed text-zinc-400">
            In a new chat, ask:{" "}
            <em className="text-zinc-200">
              &ldquo;use enwise to show my account&rdquo;
            </em>
            . {step3Tail(agent)}
          </p>
        </div>
      </div>
      )}
    </section>
  );
}

function ClaudeCodeSteps({
  rawToken,
  mcpUrl,
}: {
  rawToken: string | null;
  mcpUrl: string;
}) {
  // The dashboard server route always passes a non-null rawToken — new
  // signups get one in auth.ts::events.createUser, legacy rows get
  // auto-rotated on dashboard load. The null-guard here is just a type
  // narrowing safety net.
  const c = buildClaudeCodeCommands(rawToken ?? "", mcpUrl);

  return (
    <div className="grid gap-px overflow-hidden rounded-xl border border-zinc-900 bg-zinc-900 md:grid-cols-3">
      {/* STEP 1 — install (register the MCP server) */}
      <div className="flex flex-col bg-[#0a0a0a] p-6 sm:p-8">
        <StepKicker n="01" title="Install enwise MCP" />
        <p className="mt-4 text-sm leading-relaxed text-zinc-400">
          Click to copy the install command to your clipboard, then paste it in your terminal.
        </p>
        <div className="mt-auto pt-6">
          <CopyButton
            command={c.add}
            label="Copy install command"
            copiedLabel="Install command copied"
          />
        </div>
      </div>

      {/* STEP 2 — restart Claude Code */}
      <div className="flex flex-col bg-[#0a0a0a] p-6 sm:p-8">
        <StepKicker n="02" title="Restart Claude Code" />
        <p className="mt-4 text-sm leading-relaxed text-zinc-400">
          MCP tools only load at session start. If Claude Code is already
          running, exit and reopen it.
        </p>
      </div>

      {/* STEP 3 — paste setup prompt in the fresh session */}
      <div className="flex flex-col bg-[#0a0a0a] p-6 sm:p-8">
        <StepKicker n="03" title="Paste this in Claude Code" />
        <p className="mt-4 text-sm leading-relaxed text-zinc-400">
          One prompt that guides Claude through setting up your business profile and your first client.
        </p>
        <div className="mt-auto pt-6">
          <CopyButton command={c.firstPrompt} label="Copy setup prompt" />
        </div>
      </div>
    </div>
  );
}

function CopyButton({
  command,
  label,
  copiedLabel = "Copied",
}: {
  command: string;
  label: string;
  copiedLabel?: string;
}) {
  // Once copied, the button stays in the copied state — the value really
  // is on the clipboard until the user replaces it. Reverting to the
  // original label would lie about that.
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      // clipboard rejected
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-zinc-100 px-3.5 py-2 text-xs font-medium text-zinc-950 hover:bg-white"
    >
      {copied ? (
        <>
          <CheckIcon />
          {copiedLabel}
        </>
      ) : (
        label
      )}
    </button>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 8.5 6.5 12 13 4.5" className="animate-draw-check" />
    </svg>
  );
}

function step1Body(agent: AgentId): string {
  switch (agent) {
    case "claude-code":
      return "Click the button below, then paste it into Claude Code. Your key is in the prompt.";
    case "claude-ai":
      return "Open claude.ai. Settings, then Connectors, then Add custom connector. Name it enwise. Paste the URL above and add the Authorization header (the button copies the header value).";
    case "cursor":
      return "Click the button below to copy the JSON. Open Cursor Settings, MCP, Add new MCP server. Or edit ~/.cursor/mcp.json and paste it in.";
    case "codex":
      return "Click the button below to copy the TOML. Open ~/.codex/config.toml and paste it in.";
    case "windsurf":
      return "Click the button below to copy the JSON. Open Windsurf Settings, Cascade, Model Context Protocol. Or edit ~/.codeium/windsurf/mcp_config.json and paste it in.";
  }
}

function step2Title(agent: AgentId): string {
  switch (agent) {
    case "claude-code":
      return "Restart Claude Code";
    case "claude-ai":
      return "Save the connector";
    case "cursor":
      return "Reload Cursor";
    case "codex":
      return "Restart Codex";
    case "windsurf":
      return "Restart Windsurf";
  }
}

function step2Body(agent: AgentId): string {
  switch (agent) {
    case "claude-code":
      return "Claude Code only loads MCP tools at session start. This step is required. Most 'it isn't working' reports are because of this.";
    case "claude-ai":
      return "Once saved, the enwise connector is live in any new chat. No restart needed. The settings page should show enwise with a green Connected badge.";
    case "cursor":
      return "Reload Cursor (Cmd-Shift-P, then 'Reload Window'). The enwise tools become available in chats with MCP enabled.";
    case "codex":
      return "Quit Codex and start it again. Codex picks up MCP servers from config.toml at launch.";
    case "windsurf":
      return "Quit Windsurf and start it again. Cascade reads the MCP config at launch.";
  }
}

function step2Code(agent: AgentId): string | null {
  switch (agent) {
    case "claude-code":
      return "/exit\nclaude";
    case "claude-ai":
      return null;
    case "cursor":
      return "Cmd-Shift-P\nReload Window";
    case "codex":
      return "exit\ncodex";
    case "windsurf":
      return "Quit Windsurf\nOpen Windsurf";
  }
}

function step2Hint(agent: AgentId): string {
  switch (agent) {
    case "claude-code":
      return "Type /exit, then run claude again.";
    case "claude-ai":
      return "";
    case "cursor":
      return "Use the command palette to reload the window.";
    case "codex":
      return "Quit and reopen the CLI.";
    case "windsurf":
      return "Quit fully and reopen.";
  }
}

function step3Tail(agent: AgentId): string {
  switch (agent) {
    case "claude-code":
      return "Claude will walk you through setting up your business so you can start invoicing.";
    case "claude-ai":
      return "Claude will walk you through setting up your business so you can start invoicing.";
    case "cursor":
      return "Cursor will walk you through setting up your business so you can start invoicing.";
    case "codex":
      return "Codex will walk you through setting up your business so you can start invoicing.";
    case "windsurf":
      return "Windsurf will walk you through setting up your business so you can start invoicing.";
  }
}

function StepKicker({
  n,
  title,
}: {
  n: string;
  title: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs font-mono uppercase tracking-widest text-zinc-600">
        {n}
      </div>
      <h2 className="mt-6 min-h-14 text-xl font-semibold tracking-tight leading-7 text-zinc-100">
        {title}
      </h2>
    </div>
  );
}

function AgentPicker({
  value,
  onChange,
}: {
  value: AgentId;
  onChange: (next: AgentId) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = AGENTS.find((a) => a.id === value)!;

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group inline-flex items-center gap-1.5 rounded-md px-1 py-1 text-sm font-medium text-zinc-100 hover:bg-zinc-900 focus:bg-zinc-900 focus:outline-none"
      >
        <span className="text-[11px] font-mono uppercase tracking-widest text-zinc-500">
          Agent
        </span>
        <span className="ml-1.5">{current.label}</span>
        <svg
          viewBox="0 0 16 16"
          className={`size-3.5 text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
        >
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-2 min-w-[180px] overflow-hidden rounded-lg border border-zinc-800 bg-[#0a0a0a] py-1 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.9)]"
        >
          {AGENTS.map((a) => {
            const selected = a.id === value;
            return (
              <button
                key={a.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  onChange(a.id);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors ${
                  selected
                    ? "text-zinc-100"
                    : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
                }`}
              >
                <span>{a.label}</span>
                {selected ? (
                  <svg
                    viewBox="0 0 16 16"
                    className="size-3.5 text-zinc-500"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path
                      d="M3 8l3 3 7-7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
