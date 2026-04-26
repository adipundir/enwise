"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

export function SignInModalShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const panelRef = useRef<HTMLDivElement>(null);

  const close = () => router.replace("/");

  // ESC to close
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      aria-modal="true"
      role="dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md px-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={panelRef}
        className="relative w-full max-w-md rounded-2xl border border-zinc-800 bg-[#0a0a0a] p-8 shadow-[0_40px_100px_-20px_rgba(0,0,0,0.9)]"
      >
        <button
          type="button"
          onClick={close}
          className="absolute right-4 top-4 rounded-md p-1 text-zinc-600 transition-colors hover:bg-zinc-900 hover:text-zinc-200 focus:outline-none focus-visible:text-zinc-200"
          aria-label="Close"
        >
          <svg
            viewBox="0 0 16 16"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M3 3l10 10M13 3L3 13" strokeLinecap="round" />
          </svg>
        </button>
        {children}
      </div>
    </div>
  );
}
