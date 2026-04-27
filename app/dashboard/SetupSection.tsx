"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { rotateKeyAction } from "./actions";

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

function buildClaudeCodePrompt(rawToken: string, mcpUrl: string): string {
  // The skill file lives next to the MCP endpoint on the same host.
  const skillUrl = mcpUrl.replace(/\/api\/mcp$/, "/enwise.skill.md");
  const skillCmd = `mkdir -p ~/.claude/skills/enwise && curl -fsSL ${skillUrl} > ~/.claude/skills/enwise/SKILL.md`;
  return `Register the enwise invoicing MCP server. Run this command via your Bash tool:

claude mcp add --transport http --scope user enwise ${mcpUrl} --header "Authorization: Bearer ${rawToken}"

Then tell me to install the enwise workflow skill myself. Claude Code's auto-permission classifier blocks the Bash tool from writing into ~/.claude/skills/ (downloading skill files from external URLs counts as self-modifying instructions, which is exactly what the classifier guards against), so I'll run it in my shell. Show me this and tell me to paste it into my next prompt verbatim — the leading \`!\` is what makes Claude Code run it directly in my shell instead of through your Bash tool:

! ${skillCmd}

After both finish, \`claude mcp list\` should show enwise as Connected. Tell me to \`/exit\` and relaunch Claude Code so the new MCP tools and the skill load. In the next session, call the \`whoami\` tool and it'll walk us through setting up my business profile and first client.`;
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
 * step layout: configure, restart/reload, verify. The "make a new key
 * and prepare the config" path stays a single combined action for users
 * who lost their key.
 */
export function SetupSection({
  initialRawToken,
  currentPrefix,
  mcpUrl,
  hasInvoices,
}: {
  initialRawToken: string | null;
  currentPrefix: string | null;
  mcpUrl: string;
  hasInvoices: boolean;
}) {
  const [rawToken, setRawToken] = useState<string | null>(initialRawToken);
  const [agent, setAgent] = useState<AgentId>("claude-code");
  const [primaryCopied, setPrimaryCopied] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  // Once the user has at least one invoice, the setup steps are noise on
  // every dashboard visit. Collapse by default; user can re-open to switch
  // agent or fetch a fresh prompt.
  const [expanded, setExpanded] = useState(!hasInvoices);

  const tokenForCopy = rawToken ?? "<YOUR_KEY>";

  function payloadFor(token: string): string {
    switch (agent) {
      case "claude-code":
        return buildClaudeCodePrompt(token, mcpUrl);
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

  const primaryPayload = payloadFor(tokenForCopy);

  const payloadNoun =
    agent === "claude-code"
      ? "prompt"
      : agent === "claude-ai"
        ? "header"
        : "config";

  const primaryLabel =
    agent === "claude-code"
      ? "Copy Claude Code prompt"
      : agent === "claude-ai"
        ? "Copy bearer header"
        : agent === "codex"
          ? "Copy TOML config"
          : "Copy JSON config";

  const generateLabel = `Generate key and copy ${payloadNoun}`;

  function makeNewKeyAndCopy() {
    setConfirmOpen(false);
    startTransition(async () => {
      const r = await rotateKeyAction();
      setRawToken(r.rawToken);
      try {
        await navigator.clipboard.writeText(payloadFor(r.rawToken));
        setPrimaryCopied(true);
        setTimeout(() => setPrimaryCopied(false), 2400);
      } catch {
        // clipboard rejected; user can still click copy button
      }
    });
  }

  async function copyPrimary() {
    if (!rawToken) return;
    await navigator.clipboard.writeText(payloadFor(rawToken));
    setPrimaryCopied(true);
    setTimeout(() => setPrimaryCopied(false), 1800);
  }

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
            <AgentPicker
              value={agent}
              onChange={(next) => {
                setAgent(next);
                setPrimaryCopied(false);
              }}
            />
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

      {!expanded ? null : (
      <div className="grid gap-px overflow-hidden rounded-xl border border-zinc-900 bg-zinc-900 md:grid-cols-3">
        {/* STEP 1 */}
        <div className="flex flex-col bg-[#0a0a0a] p-6 sm:p-8">
          <StepKicker n="01" title={agent === "claude-code" ? "Copy the setup prompt" : "Copy the config"} />
          <p className="mt-4 text-sm leading-relaxed text-zinc-400">
            {step1Body(agent)}
          </p>
          {!rawToken ? (
            <p className="mt-4 text-xs leading-relaxed text-zinc-500">
              Current key:{" "}
              <code className="font-mono text-zinc-400">
                {currentPrefix ? `${currentPrefix}…` : "(none)"}
              </code>
            </p>
          ) : null}
          <div className="mt-auto pt-8 space-y-3">
            {rawToken ? (
              <button
                type="button"
                onClick={copyPrimary}
                className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-zinc-100 px-3.5 py-2 text-xs font-medium text-zinc-950 hover:bg-white"
              >
                {primaryCopied ? "Copied" : primaryLabel}
              </button>
            ) : confirmOpen ? (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={makeNewKeyAndCopy}
                  disabled={pending}
                  className="w-full rounded-md bg-red-900/80 px-3.5 py-2 text-xs font-medium text-red-50 hover:bg-red-900 disabled:opacity-60"
                >
                  {pending ? "Generating key..." : `Yes, ${generateLabel.toLowerCase()}`}
                </button>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-zinc-500">
                    Your old key will stop working.
                  </p>
                  <button
                    type="button"
                    onClick={() => setConfirmOpen(false)}
                    className="text-xs text-zinc-500 hover:text-zinc-200"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-zinc-100 px-3.5 py-2 text-xs font-medium text-zinc-950 hover:bg-white"
              >
                {generateLabel}
              </button>
            )}
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
      <h2 className="mt-6 text-xl font-semibold tracking-tight text-zinc-100">
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
