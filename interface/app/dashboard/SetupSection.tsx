"use client";

import { useEffect, useRef, useState } from "react";

type AgentId = "claude-code" | "cursor" | "anti-gravity" | "windsurf" | "claude-ai";

interface AgentMeta {
  id: AgentId;
  label: string;
}

const AGENTS: AgentMeta[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "anti-gravity", label: "Anti-Gravity" },
  { id: "windsurf", label: "Windsurf" },
  { id: "claude-ai", label: "Claude.ai" },
];

const FIRST_PROMPT =
  "Use whoami to show my enwise account, then walk me through setting up my business profile and first client.";

function buildClaudeCodeCommands(
  rawToken: string,
  mcpUrl: string,
): { add: string; firstPrompt: string } {
  const removeCmd = `claude mcp remove enwise -s user 2>/dev/null`;
  const addCmd = `claude mcp add --transport http --scope user enwise ${mcpUrl} --header "Authorization: Bearer ${rawToken}"`;
  return {
    add: `${removeCmd}; ${addCmd}`,
    firstPrompt: FIRST_PROMPT,
  };
}

function buildCursorPrompt(rawToken: string, mcpUrl: string): string {
  return `Add enwise as an MCP server. Write the following under mcpServers.enwise in ~/.cursor/mcp.json (create the file if it doesn't exist, merge if it does): url "${mcpUrl}", Authorization header "Bearer ${rawToken}". Then reload the window and use whoami to show my enwise account, then walk me through setting up my business profile and first client.`;
}

function buildAntiGravityPrompt(rawToken: string, mcpUrl: string): string {
  return `Add enwise as an MCP server. Write the following under mcpServers.enwise in your MCP config file (create it if it doesn't exist, merge if it does): url "${mcpUrl}", Authorization header "Bearer ${rawToken}". Then restart and use whoami to show my enwise account, then walk me through setting up my business profile and first client.`;
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
  const [expanded, setExpanded] = useState(!hasInvoices);

  const rawToken = initialRawToken;

  const isTerminalAgent = agent === "claude-code";
  const isPromptAgent = agent === "cursor" || agent === "anti-gravity";

  function payloadFor(token: string): string {
    switch (agent) {
      case "claude-code":
        return buildClaudeCodeCommands(token, mcpUrl).add;
      case "cursor":
        return buildCursorPrompt(token, mcpUrl);
      case "anti-gravity":
        return buildAntiGravityPrompt(token, mcpUrl);
      case "claude-ai":
        return `Authorization: Bearer ${token}`;
      case "windsurf":
        return buildWindsurfConfig(token, mcpUrl);
    }
  }

  const primaryLabel = isTerminalAgent
    ? "Copy install command"
    : isPromptAgent
      ? "Copy setup prompt"
      : agent === "claude-ai"
        ? "Copy bearer header"
        : "Copy JSON config";

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

      {!expanded ? null : isTerminalAgent ? (
        <TerminalInstallSteps rawToken={rawToken} mcpUrl={mcpUrl} />
      ) : isPromptAgent ? (
        <PromptInstallSteps agent={agent} rawToken={rawToken} mcpUrl={mcpUrl} />
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

function TerminalInstallSteps({
  rawToken,
  mcpUrl,
}: {
  rawToken: string | null;
  mcpUrl: string;
}) {
  const c = buildClaudeCodeCommands(rawToken ?? "", mcpUrl);
  return (
    <div className="grid gap-px overflow-hidden rounded-xl border border-zinc-900 bg-zinc-900 md:grid-cols-3">
      <div className="flex flex-col bg-[#0a0a0a] p-6 sm:p-8">
        <StepKicker n="01" title="Install enwise MCP" />
        <p className="mt-4 text-sm leading-relaxed text-zinc-400">
          Click to copy, then paste the command into your terminal and run it.
          Your key is already embedded.
        </p>
        <div className="mt-auto pt-6">
          <CopyButton
            command={c.add}
            label="Copy install command"
            copiedLabel="Install command copied"
          />
        </div>
      </div>
      <div className="flex flex-col bg-[#0a0a0a] p-6 sm:p-8">
        <StepKicker n="02" title="Restart Claude Code" />
        <p className="mt-4 text-sm leading-relaxed text-zinc-400">
          MCP tools only load at session start. If Claude Code is already
          running, exit and reopen it.
        </p>
      </div>
      <div className="flex flex-col bg-[#0a0a0a] p-6 sm:p-8">
        <StepKicker n="03" title="Paste this in Claude Code" />
        <p className="mt-4 text-sm leading-relaxed text-zinc-400">
          One prompt that guides Claude through setting up your business profile
          and your first client.
        </p>
        <div className="mt-auto pt-6">
          <CopyButton command={c.firstPrompt} label="Copy setup prompt" />
        </div>
      </div>
    </div>
  );
}

function PromptInstallSteps({
  agent,
  rawToken,
  mcpUrl,
}: {
  agent: "cursor" | "anti-gravity";
  rawToken: string | null;
  mcpUrl: string;
}) {
  const token = rawToken ?? "";
  const prompt =
    agent === "cursor"
      ? buildCursorPrompt(token, mcpUrl)
      : buildAntiGravityPrompt(token, mcpUrl);
  const agentName = agent === "cursor" ? "Cursor" : "Anti-Gravity";

  return (
    <div className="grid gap-px overflow-hidden rounded-xl border border-zinc-900 bg-zinc-900 md:grid-cols-2">
      <div className="flex flex-col bg-[#0a0a0a] p-6 sm:p-8">
        <StepKicker n="01" title={`Paste this into ${agentName}`} />
        <p className="mt-4 text-sm leading-relaxed text-zinc-400">
          Copy the prompt below and paste it into a new {agentName} chat.{" "}
          {agentName} will add the MCP server, reload, and walk you through
          setup — no terminal needed.
        </p>
        <div className="mt-auto pt-6">
          <CopyButton
            command={prompt}
            label="Copy setup prompt"
            copiedLabel="Prompt copied"
          />
        </div>
      </div>
      <div className="flex flex-col bg-[#0a0a0a] p-6 sm:p-8">
        <StepKicker n="02" title="Verify it works" />
        <p className="mt-4 text-sm leading-relaxed text-zinc-400">
          After {agentName} restarts with the new config, ask:{" "}
          <em className="text-zinc-200">
            &ldquo;use enwise to show my account&rdquo;
          </em>
          . It will walk you through your business profile and first client.
        </p>
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
    case "cursor":
    case "anti-gravity":
      return "Click to copy the install command, then paste it in your terminal.";
    case "claude-ai":
      return "Open claude.ai. Settings, then Connectors, then Add custom connector. Name it enwise. Paste the MCP URL and add the Authorization header (the button copies the header value).";
    case "windsurf":
      return "Click the button below to copy the JSON. Open Windsurf Settings, Cascade, Model Context Protocol. Or edit ~/.codeium/windsurf/mcp_config.json and paste it in.";
  }
}

function step2Title(agent: AgentId): string {
  switch (agent) {
    case "claude-code":
      return "Restart Claude Code";
    case "cursor":
      return "Reload Cursor";
    case "anti-gravity":
      return "Restart Anti-Gravity";
    case "claude-ai":
      return "Save the connector";
    case "windsurf":
      return "Restart Windsurf";
  }
}

function step2Body(agent: AgentId): string {
  switch (agent) {
    case "claude-code":
      return "Claude Code only loads MCP tools at session start. This step is required.";
    case "cursor":
      return "Reload Cursor (Cmd-Shift-P, then 'Reload Window'). The enwise tools become available in Agent mode.";
    case "anti-gravity":
      return "Quit Anti-Gravity and reopen it. It reads the MCP config at launch.";
    case "claude-ai":
      return "Once saved, the enwise connector is live in any new chat. The settings page should show enwise with a green Connected badge.";
    case "windsurf":
      return "Quit Windsurf and start it again. Cascade reads the MCP config at launch.";
  }
}

function step2Code(agent: AgentId): string | null {
  switch (agent) {
    case "cursor":
      return "Cmd-Shift-P\nReload Window";
    default:
      return null;
  }
}

function step2Hint(agent: AgentId): string {
  switch (agent) {
    case "cursor":
      return "Use the command palette to reload the window.";
    default:
      return "";
  }
}

function step3Tail(agent: AgentId): string {
  const name =
    agent === "claude-ai"
      ? "Claude"
      : agent === "windsurf"
        ? "Windsurf"
        : agent;
  return `${name} will walk you through setting up your business so you can start invoicing.`;
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
