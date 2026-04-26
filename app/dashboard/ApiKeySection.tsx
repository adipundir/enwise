"use client";

import { useState, useTransition } from "react";
import { rotateKeyAction } from "./actions";

/**
 * Compact API key card. Shows the raw key inline when freshly minted (signup
 * bootstrap or after a rotation). Otherwise shows the prefix + a Rotate
 * action. Raw tokens are never persisted, so the inline reveal is the only
 * chance to copy.
 */
export function ApiKeyCard({
  initialRawToken,
  currentPrefix,
  onRawTokenChange,
}: {
  initialRawToken: string | null;
  currentPrefix: string | null;
  onRawTokenChange?: (rawToken: string) => void;
}) {
  const [rawToken, setRawToken] = useState<string | null>(initialRawToken);
  const [copied, setCopied] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleRotate() {
    setConfirmOpen(false);
    startTransition(async () => {
      const result = await rotateKeyAction();
      setRawToken(result.rawToken);
      onRawTokenChange?.(result.rawToken);
      setCopied(false);
    });
  }

  async function copyKey() {
    if (!rawToken) return;
    await navigator.clipboard.writeText(rawToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="flex flex-col justify-between bg-[#0a0a0a] p-8">
      <div>
        <div className="text-xs font-mono uppercase tracking-widest text-zinc-600">
          01
        </div>
        <h2 className="mt-6 text-xl font-semibold tracking-tight text-zinc-100">
          Your API key
        </h2>

        {rawToken ? (
          <div className="mt-4 space-y-3">
            <div className="flex items-center gap-2">
              <code className="flex-1 select-all break-all rounded-md border border-zinc-800 bg-[#0a0a0a] px-3 py-2 font-mono text-xs text-zinc-100">
                {rawToken}
              </code>
              <button
                type="button"
                onClick={copyKey}
                className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-100 hover:bg-zinc-800"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="text-xs font-medium text-emerald-400">
              Copy it now. You won&apos;t see it again.
            </p>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="flex items-center gap-3">
              <code className="font-mono text-sm text-zinc-200">
                {currentPrefix ? `${currentPrefix}…` : "—"}
              </code>
              <span className="text-[11px] text-zinc-600">hidden</span>
            </div>
            <p className="text-xs leading-relaxed text-zinc-500">
              Lost your key? Rotate to mint a new one.
            </p>
          </div>
        )}
      </div>

      <div className="mt-8 flex items-center gap-3">
        {!confirmOpen && !rawToken ? (
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={pending}
            className="text-sm text-zinc-400 hover:text-zinc-100 disabled:opacity-60"
          >
            Rotate key
          </button>
        ) : confirmOpen ? (
          <>
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              className="text-sm text-zinc-500 hover:text-zinc-200"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleRotate}
              disabled={pending}
              className="rounded-md bg-red-900/80 px-3 py-1.5 text-xs font-medium text-red-50 hover:bg-red-900 disabled:opacity-60"
            >
              {pending ? "Rotating…" : "Confirm rotate"}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
