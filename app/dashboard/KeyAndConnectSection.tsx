"use client";

import { useState } from "react";
import { ApiKeyCard } from "./ApiKeySection";
import { ConnectClaudeCard } from "./ConnectClaudeCard";

/**
 * Wrapper that keeps the API key + Connect Claude cards in sync. The raw
 * token is held here so a rotation in the left card updates the right card's
 * copy-prompt button immediately.
 */
export function KeyAndConnectSection({
  initialRawToken,
  currentPrefix,
  mcpUrl,
}: {
  initialRawToken: string | null;
  currentPrefix: string | null;
  mcpUrl: string;
}) {
  const [rawToken, setRawToken] = useState<string | null>(initialRawToken);

  return (
    <section className="grid gap-px bg-zinc-900 sm:grid-cols-2">
      <ApiKeyCard
        initialRawToken={initialRawToken}
        currentPrefix={currentPrefix}
        onRawTokenChange={setRawToken}
      />
      <ConnectClaudeCard rawToken={rawToken} mcpUrl={mcpUrl} />
    </section>
  );
}
