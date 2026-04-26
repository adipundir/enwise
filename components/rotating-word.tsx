"use client";

import { useEffect, useState } from "react";

/**
 * Swaps through a list of words on an interval with a short fade-in/out.
 * Used in the hero to signal that enwise works across multiple MCP clients
 * (Claude, Cursor, Codex, …) rather than being Claude-only.
 *
 * SSR-safe: first paint renders `words[0]`, so the hero heading matches
 * the server HTML and there's no hydration jitter.
 */
export function RotatingWord({
  words,
  intervalMs = 2200,
  fadeMs = 280,
  className = "",
}: {
  words: string[];
  intervalMs?: number;
  fadeMs?: number;
  className?: string;
}) {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (words.length <= 1) return;
    const tick = setInterval(() => {
      setVisible(false);
      const swap = setTimeout(() => {
        setIndex((i) => (i + 1) % words.length);
        setVisible(true);
      }, fadeMs);
      return () => clearTimeout(swap);
    }, intervalMs);
    return () => clearInterval(tick);
  }, [words.length, intervalMs, fadeMs]);

  return (
    <span
      aria-live="polite"
      className={`inline-block ${className}`}
      style={{
        transition: `opacity ${fadeMs}ms ease-out, transform ${fadeMs}ms ease-out`,
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(-6px)",
      }}
    >
      {words[index]}
    </span>
  );
}
