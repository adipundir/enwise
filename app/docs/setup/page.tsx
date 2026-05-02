import Link from "next/link";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { auth } from "@/auth";

export default async function SetupDocsPage() {
  const session = await auth();
  const primaryHref = session ? "/dashboard" : "/signin";
  const baseUrl =
    process.env.PUBLIC_BASE_URL ||
    process.env.AUTH_URL ||
    "http://localhost:3000";
  const mcpUrl = `${baseUrl}/api/mcp`;

  return (
    <div className="flex flex-1 flex-col">
      <SiteHeader ctaHref={primaryHref} />
      <main className="mx-auto w-full max-w-3xl px-6 pt-20 pb-24 sm:pt-24">
        <div className="text-[11px] uppercase tracking-widest text-zinc-500">
          Setup
        </div>
        <h1 className="mt-3 display text-3xl leading-tight sm:text-4xl text-zinc-100">
          End-to-end setup.
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-zinc-400">
          Five minutes from account to first invoice through Claude. No forms
          to fill beyond the API key.
        </p>

        <ol className="mt-10 space-y-10">
          <Step
            n="01"
            title="Create an account"
            body={
              <>
                <p>
                  Sign in with GitHub or Google. A default business profile is
                  created for you so Claude always has context.
                </p>
                <p className="mt-2">
                  <Link href="/signin" className="text-zinc-200 underline underline-offset-2 hover:text-white">
                    Sign in →
                  </Link>
                </p>
              </>
            }
          />

          <Step
            n="02"
            title="Grab your API key"
            body={
              <>
                <p>
                  Your key is minted and shown once on the dashboard the first
                  time you sign in. Copy it then; it&apos;s never shown again.
                  If you lost it, rotate from the dashboard to mint a new one.
                </p>
              </>
            }
          />

          <Step
            n="03"
            title="Connect Claude"
            body={
              <>
                <p>
                  Pick whichever client you use. Claude Code is the primary
                  flow. the dashboard gives you a one-shot copy-paste prompt
                  that registers the server for you.
                </p>

                <h3 className="mt-5 text-sm font-semibold text-zinc-200">
                  Claude Code (CLI)
                </h3>
                <p className="mt-1 text-sm text-zinc-400">
                  From the dashboard, click <strong>Copy Claude Code prompt</strong>.
                  Paste it into Claude Code. Claude registers the server at
                  user scope and you restart once to pick up the new tools. Or
                  run it manually:
                </p>
                <pre className="mt-2 overflow-auto rounded-md border border-zinc-800 bg-[#0a0a0a] p-4 font-mono text-xs leading-relaxed text-zinc-100">
{`claude mcp add --transport http --scope user enwise \\
  ${mcpUrl} \\
  --header "Authorization: Bearer <YOUR_TOKEN>"`}
                </pre>

                <h3 className="mt-5 text-sm font-semibold text-zinc-200">
                  Claude.ai (web &amp; desktop with native MCP connectors)
                </h3>
                <ol className="mt-2 space-y-1 text-sm text-zinc-400 list-decimal list-inside">
                  <li>Settings → Connectors → Add custom connector</li>
                  <li>
                    Name: <code className="rounded bg-zinc-900 px-1 py-0.5 text-xs">enwise</code>
                  </li>
                  <li>
                    URL:{" "}
                    <code className="break-all rounded bg-zinc-900 px-1 py-0.5 text-xs">
                      {mcpUrl}
                    </code>
                  </li>
                  <li>
                    Header:{" "}
                    <code className="rounded bg-zinc-900 px-1 py-0.5 text-xs">
                      Authorization: Bearer &lt;YOUR_TOKEN&gt;
                    </code>
                  </li>
                </ol>

                <h3 className="mt-5 text-sm font-semibold text-zinc-200">
                  Claude Desktop (config file + mcp-remote bridge)
                </h3>
                <p className="mt-1 text-sm text-zinc-400">
                  Edit{" "}
                  <code className="rounded bg-zinc-900 px-1 py-0.5 text-xs">
                    ~/Library/Application Support/Claude/claude_desktop_config.json
                  </code>
                </p>
                <pre className="mt-2 overflow-auto rounded-md border border-zinc-800 bg-[#0a0a0a] p-4 font-mono text-xs leading-relaxed text-zinc-100">
{`{
  "mcpServers": {
    "enwise": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "${mcpUrl}",
        "--header",
        "Authorization: Bearer <YOUR_TOKEN>"
      ]
    }
  }
}`}
                </pre>
                <p className="mt-2 text-xs text-zinc-500">
                  Restart Claude Desktop after saving the config.
                </p>
              </>
            }
          />

          <Step
            n="04"
            title="First invoice"
            body={
              <>
                <p>
                  Start a new chat in Claude and try any of these. Claude will
                  call the right tools automatically.
                </p>
                <ul className="mt-3 space-y-1 text-sm text-zinc-300">
                  <li>→ &ldquo;What does my enwise business profile look like?&rdquo;</li>
                  <li>→ &ldquo;Set up my business: I&apos;m Acme Design, based in Brooklyn, default currency USD.&rdquo;</li>
                  <li>→ &ldquo;Add a client called Globex, email bill@globex.com.&rdquo;</li>
                  <li>→ &ldquo;Invoice Globex $5,000 for Q2 brand refresh, 8% tax, net 30, and email it.&rdquo;</li>
                  <li>→ &ldquo;How much has Globex paid me this year?&rdquo;</li>
                </ul>
              </>
            }
          />
        </ol>
      </main>

      <SiteFooter />
    </div>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: React.ReactNode }) {
  return (
    <li className="flex gap-6">
      <div className="w-12 shrink-0 pt-1 font-mono text-xs uppercase tracking-widest text-zinc-600">
        {n}
      </div>
      <div className="flex-1 min-w-0">
        <h2 className="text-lg font-semibold tracking-tight text-zinc-100">
          {title}
        </h2>
        <div className="mt-2 text-sm leading-relaxed text-zinc-400">{body}</div>
      </div>
    </li>
  );
}

