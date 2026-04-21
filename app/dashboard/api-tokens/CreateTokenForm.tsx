"use client";

import { useActionState, useState } from "react";
import { createTokenAction, type CreateTokenState } from "./actions";

export function CreateTokenForm() {
  const [state, formAction, pending] = useActionState<
    CreateTokenState | undefined,
    FormData
  >(createTokenAction, undefined);
  const [copied, setCopied] = useState(false);

  async function copyToken() {
    if (!state?.rawToken) return;
    await navigator.clipboard.writeText(state.rawToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-5">
      <form action={formAction} className="flex flex-wrap items-center gap-3">
        <input
          name="name"
          placeholder="Claude Desktop — MacBook"
          className="flex-1 min-w-[260px] rounded-md border border-zinc-800 bg-[#0d0d0d] px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
          maxLength={80}
          required
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-white disabled:opacity-60"
        >
          {pending ? "Creating…" : "Create token"}
        </button>
      </form>

      {state?.error && (
        <p className="text-sm text-red-400">{state.error}</p>
      )}

      {state?.ok && state.rawToken && (
        <div className="space-y-3 rounded-xl border border-emerald-900/60 bg-emerald-950/20 p-5">
          <div className="flex items-center gap-2 text-sm text-emerald-400">
            <span className="size-1.5 rounded-full bg-emerald-400" />
            Token created: {state.tokenName}
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
            Store this somewhere safe. It won't be shown again. You can always
            create another token if you lose it.
          </p>
        </div>
      )}
    </div>
  );
}
