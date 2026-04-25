"use client";

import { useState, useTransition } from "react";
import { createTokenAction, type CreateTokenState } from "./actions";

export function CreateTokenForm() {
  const [state, setState] = useState<CreateTokenState | null>(null);
  const [pending, startTransition] = useTransition();
  const [copied, setCopied] = useState(false);

  function handleCreate() {
    startTransition(async () => {
      const result = await createTokenAction();
      setState(result);
      setCopied(false);
    });
  }

  async function copyToken() {
    if (!state?.rawToken) return;
    await navigator.clipboard.writeText(state.rawToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-5">
      <button
        type="button"
        onClick={handleCreate}
        disabled={pending}
        className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-white disabled:opacity-60"
      >
        {pending ? "Generating…" : "Generate token"}
      </button>

      {state?.error && (
        <p className="text-sm text-red-400">{state.error}</p>
      )}

      {state?.ok && state.rawToken && (
        <div className="space-y-3 rounded-xl border border-emerald-900/60 bg-emerald-950/20 p-5">
          <div className="flex items-center gap-2 text-sm text-emerald-400">
            <span className="size-1.5 rounded-full bg-emerald-400" />
            New token: {state.tokenName}
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 select-all break-all rounded-md border border-zinc-800 bg-[#0a0a0a] px-3 py-2 font-mono text-xs text-zinc-100">
              {state.rawToken}
            </code>
            <button
              type="button"
              onClick={copyToken}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 hover:bg-zinc-800"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="text-xs text-zinc-500">
            Store this somewhere safe. It won&apos;t be shown again. Generate
            another anytime if you lose it.
          </p>
        </div>
      )}
    </div>
  );
}
