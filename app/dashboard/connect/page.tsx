import Link from "next/link";
import { ClaudeCodeSetup } from "./ClaudeCodeSetup";
import { CopyButton } from "./CopyButton";

export default function ConnectPage() {
  const baseUrl =
    process.env.PUBLIC_BASE_URL ||
    process.env.AUTH_URL ||
    "http://localhost:3000";
  const mcpUrl = `${baseUrl}/api/mcp`;

  const desktopConfig = JSON.stringify(
    {
      mcpServers: {
        enwise: {
          command: "npx",
          args: [
            "-y",
            "mcp-remote",
            mcpUrl,
            "--header",
            "Authorization: Bearer <YOUR_TOKEN>",
          ],
        },
      },
    },
    null,
    2,
  );

  return (
    <div className="space-y-10">
      <div className="space-y-2">
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          Setup
        </div>
        <h1 className="display text-3xl text-zinc-100 sm:text-4xl">
          Connect to Claude
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">
          One prompt, one paste. Claude Code wires itself up.
        </p>
      </div>

      {/* Hero: one-prompt Claude Code setup */}
      <section className="space-y-5 rounded-2xl border border-zinc-800 bg-[#0c0c0c] p-6">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-zinc-100">
            Claude Code (recommended)
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            Paste your key below, copy the prompt, paste into a Claude Code
            session. Claude runs <code>claude mcp add</code> for you and
            verifies the connection.
          </p>
        </div>
        <ClaudeCodeSetup mcpUrl={mcpUrl} />
      </section>

      {/* Demoted: Other clients */}
      <section className="space-y-6 rounded-2xl border border-zinc-900 bg-[#0c0c0c] p-6">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-zinc-100">
            Other clients
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            Endpoint:{" "}
            <code className="select-all break-all text-zinc-300">{mcpUrl}</code>
            . Auth:{" "}
            <code className="text-zinc-300">
              Authorization: Bearer &lt;YOUR_TOKEN&gt;
            </code>
            .
          </p>
        </div>

        <details className="group rounded-md border border-zinc-900 bg-[#0a0a0a] p-4">
          <summary className="cursor-pointer text-sm text-zinc-200 marker:text-zinc-600">
            Claude.ai (web / desktop Connectors)
          </summary>
          <ol className="mt-3 space-y-1.5 text-sm text-zinc-400">
            <li>1. Settings → Connectors → <em>Add custom connector</em>.</li>
            <li>2. Name <strong>enwise</strong>, paste the endpoint URL.</li>
            <li>
              3. Add header{" "}
              <code className="rounded bg-zinc-900 px-1.5 py-0.5 text-xs">
                Authorization: Bearer &lt;YOUR_TOKEN&gt;
              </code>
              .
            </li>
            <li>
              4. Save, then ask Claude to call{" "}
              <code className="rounded bg-zinc-900 px-1.5 py-0.5 text-xs">
                whoami
              </code>
              .
            </li>
          </ol>
        </details>

        <details className="group rounded-md border border-zinc-900 bg-[#0a0a0a] p-4">
          <summary className="flex cursor-pointer items-center justify-between text-sm text-zinc-200 marker:text-zinc-600">
            <span>Claude Desktop (config file)</span>
            <CopyButton value={desktopConfig} label="Copy JSON" />
          </summary>
          <p className="mt-3 text-xs text-zinc-500">
            Edit{" "}
            <code className="rounded bg-zinc-900 px-1.5 py-0.5 text-xs">
              ~/Library/Application Support/Claude/claude_desktop_config.json
            </code>
            , replace <code>&lt;YOUR_TOKEN&gt;</code>, restart Claude Desktop.
          </p>
          <pre className="mt-3 overflow-auto rounded-md border border-zinc-800 bg-[#0a0a0a] p-4 font-mono text-xs leading-relaxed text-zinc-100">
            {desktopConfig}
          </pre>
        </details>
      </section>

      {/* Optional skill */}
      <section className="flex items-center justify-between gap-4 rounded-2xl border border-zinc-900 bg-[#0c0c0c] p-6">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-zinc-100">
            Optional: enwise Claude Skill
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            Teaches Claude the canonical workflows. Drop into your skills
            folder or paste as a custom instruction.
          </p>
        </div>
        <Link
          href="/enwise.skill.md"
          className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-100 hover:bg-zinc-800"
        >
          Download
        </Link>
      </section>
    </div>
  );
}
