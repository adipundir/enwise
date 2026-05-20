"use client";

import { useState } from "react";

export const OUTSTANDING_HIDDEN_COOKIE = "enwise.outstanding.hidden";

/**
 * The Outstanding stat shows real money figures, which the user might not
 * want visible during a screen share or in public. Toggle hides the
 * number behind asterisks; choice persists in a cookie so the server
 * renders the right state on first paint (no value-leak flicker on
 * reload) and the preference survives across visits.
 */
export function OutstandingStat({
  value,
  small,
  initialHidden = false,
}: {
  value: string;
  small?: boolean;
  initialHidden?: boolean;
}) {
  const [hidden, setHidden] = useState(initialHidden);

  function toggle() {
    setHidden((prev) => {
      const next = !prev;
      // 1-year cookie. Path=/ so it applies to every dashboard subroute.
      // SameSite=Lax so it's sent on top-level navigations but not on
      // cross-site subrequests.
      if (next) {
        document.cookie = `${OUTSTANDING_HIDDEN_COOKIE}=1; Path=/; Max-Age=31536000; SameSite=Lax`;
      } else {
        document.cookie = `${OUTSTANDING_HIDDEN_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
      }
      return next;
    });
  }

  const isHidden = hidden;

  return (
    <div className="group relative bg-[#0a0a0a] px-5 py-6">
      <div className="text-[10px] uppercase tracking-widest text-zinc-500">
        Outstanding
      </div>
      <button
        type="button"
        onClick={toggle}
        aria-label={hidden ? "Show outstanding" : "Hide outstanding"}
        className="absolute right-3 top-3 rounded p-1 text-zinc-600 opacity-0 transition-opacity hover:text-zinc-200 focus:outline-none focus-visible:opacity-100 group-hover:opacity-100"
      >
        {hidden ? <EyeIcon /> : <EyeOffIcon />}
      </button>
      <div
        className={`mt-2 flex items-center font-semibold text-zinc-100 tracking-tight ${small ? "text-base h-6" : "text-2xl h-8"}`}
      >
        {isHidden ? (
          <span aria-label="hidden" className="tracking-[0.15em]">
            ✳✳✳✳✳
          </span>
        ) : (
          value
        )}
      </div>
    </div>
  );
}

function EyeIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path
        d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path
        d="M2 2l12 12M6.5 3.5A7.6 7.6 0 0 1 8 3.5c4.5 0 7 5 7 5a13.6 13.6 0 0 1-2.2 2.7M11 11.5A7 7 0 0 1 8 12.5c-4.5 0-7-5-7-5a14 14 0 0 1 3-3.5M6.5 6.5a2 2 0 0 0 3 3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
