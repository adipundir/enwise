import Link from "next/link";
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
        envoice: {
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
        <h1 className="display text-3xl text-zinc-100 sm:text-4xl">Connect to Claude</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">
          Point Claude at your envoice MCP server. You&apos;ll need an API token.{" "}
          <Link
            href="/dashboard/api-tokens"
            className="text-zinc-200 underline underline-offset-2 hover:text-white"
          >
            Create one here
          </Link>{" "}
          if you haven&apos;t yet.
        </p>
      </div>

      <section className="space-y-4 rounded-2xl border border-zinc-900 bg-[#0c0c0c] p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight text-zinc-100">
              Endpoint
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              Everything goes through a single streamable-HTTP endpoint.
            </p>
          </div>
          <CopyButton value={mcpUrl} />
        </div>
        <code className="block select-all break-all rounded-md border border-zinc-800 bg-[#0a0a0a] px-3 py-2 font-mono text-xs text-zinc-100">
          {mcpUrl}
        </code>
      </section>

      <section className="space-y-4 rounded-2xl border border-zinc-900 bg-[#0c0c0c] p-6">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-zinc-100">
            Option A: Claude.ai (web / desktop Connectors)
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            If your Claude client supports remote MCP servers directly, this is
            the simplest path.
          </p>
        </div>
        <ol className="space-y-2 text-sm text-zinc-300">
          <li>
            <span className="text-zinc-500">1. </span>
            Open Claude → Settings → Connectors → <em>Add custom connector</em>.
          </li>
          <li>
            <span className="text-zinc-500">2. </span>
            Name it <strong>envoice</strong>, paste the endpoint URL above.
          </li>
          <li>
            <span className="text-zinc-500">3. </span>
            For authentication, add header{" "}
            <code className="rounded bg-zinc-900 px-1.5 py-0.5 text-xs">
              Authorization: Bearer &lt;YOUR_TOKEN&gt;
            </code>
            .
          </li>
          <li>
            <span className="text-zinc-500">4. </span>
            Save. Start a new chat and ask Claude to call{" "}
            <code className="rounded bg-zinc-900 px-1.5 py-0.5 text-xs">
              whoami
            </code>
            . You should see your business profile.
          </li>
        </ol>
      </section>

      <section className="space-y-4 rounded-2xl border border-zinc-900 bg-[#0c0c0c] p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight text-zinc-100">
              Option B: Claude Desktop (config file)
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              Edit{" "}
              <code className="rounded bg-zinc-900 px-1.5 py-0.5 text-xs">
                ~/Library/Application&nbsp;Support/Claude/claude_desktop_config.json
              </code>
              . Uses the <code>mcp-remote</code> bridge so you can use it even
              on builds that don&apos;t yet support HTTP transports directly.
            </p>
          </div>
          <CopyButton value={desktopConfig} label="Copy JSON" />
        </div>
        <pre className="overflow-auto rounded-md border border-zinc-800 bg-[#0a0a0a] p-4 font-mono text-xs leading-relaxed text-zinc-100">
          {desktopConfig}
        </pre>
        <p className="text-xs text-zinc-500">
          Replace <code>&lt;YOUR_TOKEN&gt;</code> with the raw token shown right
          after you create it on the API tokens page. Restart Claude Desktop
          after editing the config.
        </p>
      </section>

      <section className="space-y-4 rounded-2xl border border-zinc-900 bg-[#0c0c0c] p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight text-zinc-100">
              Optional: install the envoice Claude Skill
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              A short instruction file that teaches Claude the canonical
              workflows (onboarding, sending, finding clients, etc). Drop it in
              your skills folder or paste it as a Claude.ai custom instruction.
            </p>
          </div>
          <a
            href="/envoice.skill.md"
            download
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-100 hover:bg-zinc-800"
          >
            Download
          </a>
        </div>
        <p className="text-xs text-zinc-500">
          Not required. envoice tool descriptions already guide Claude through
          every operation; the skill just makes multi-step flows snappier.
        </p>
      </section>

      <section className="rounded-2xl border border-zinc-900 bg-[#0c0c0c] p-6">
        <h2 className="text-base font-semibold tracking-tight text-zinc-100">
          Smoke-test it
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          Once connected, try these prompts in Claude:
        </p>
        <ul className="mt-3 space-y-1.5 text-sm text-zinc-300">
          <li>→ &ldquo;What does my envoice business profile look like right now?&rdquo;</li>
          <li>→ &ldquo;Set up my business: I&apos;m Acme Design, based in Brooklyn, default currency USD.&rdquo;</li>
          <li>→ &ldquo;Add a client called Globex, email bill@globex.com.&rdquo;</li>
          <li>→ &ldquo;Invoice Globex $5,000 for Q2 brand refresh, 8% tax, net 30, and email it.&rdquo;</li>
        </ul>
      </section>
    </div>
  );
}
