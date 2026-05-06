"use client";

import { useState } from "react";

export function CopyableField({
  value,
  mono,
}: {
  value: string;
  mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // clipboard rejected — no fallback, the value is still visible to copy by hand
    }
  }

  return (
    <div className="flex items-center gap-2">
      <span className={mono ? "font-mono text-zinc-900" : "text-zinc-900"}>
        {value}
      </span>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : `Copy ${value}`}
        className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
      >
        {copied ? (
          <svg
            viewBox="0 0 16 16"
            className="size-3.5 text-emerald-600"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M3 8.5 6.5 12 13 4.5" className="animate-draw-check" />
          </svg>
        ) : (
          <svg
            viewBox="0 0 16 16"
            className="size-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden
          >
            <rect x="5" y="5" width="8" height="8" rx="1.5" />
            <path
              d="M3 11V4a1 1 0 0 1 1-1h7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>
    </div>
  );
}
