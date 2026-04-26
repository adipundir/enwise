"use client";

import { useState, useTransition } from "react";
import {
  createBusinessAction,
  setDefaultBusinessAction,
} from "./actions";

export interface BusinessSummary {
  id: string;
  name: string;
  plan: "free" | "pro";
  defaultCurrency: string;
  invoiceCount: number;
  clientCount: number;
  isDefault: boolean;
}

export function BusinessesSection({ businesses }: { businesses: BusinessSummary[] }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit() {
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required.");
      return;
    }
    const fd = new FormData();
    fd.set("name", trimmed);
    startTransition(async () => {
      const r = await createBusinessAction(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setName("");
      setAdding(false);
    });
  }

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold tracking-tight text-zinc-100">
          Businesses
        </h2>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="text-xs text-zinc-400 hover:text-zinc-100"
        >
          {adding ? "Cancel" : "+ New business"}
        </button>
      </div>

      {adding ? (
        <div className="mb-4 rounded-lg border border-zinc-800 bg-[#0a0a0a] p-4">
          <label className="text-[11px] uppercase tracking-widest text-zinc-500">
            Business name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme LLC"
            autoFocus
            className="mt-2 w-full rounded-md border border-zinc-800 bg-[#0c0c0c] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-600"
            disabled={isPending}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          {error ? (
            <p className="mt-2 text-xs text-red-400">{error}</p>
          ) : (
            <p className="mt-2 text-xs text-zinc-600">
              Address, tax ID, and currency can be filled in later via Claude.
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={isPending}
              className="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-950 hover:bg-white disabled:opacity-60"
            >
              {isPending ? "Creating…" : "Create"}
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setName("");
                setError(null);
              }}
              className="rounded-md border border-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-700"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-zinc-900">
        {businesses.map((b) => (
          <BusinessRow key={b.id} business={b} />
        ))}
        {businesses.length === 0 ? (
          <div className="px-5 py-4 text-sm text-zinc-500">
            No businesses yet. Create one above.
          </div>
        ) : null}
      </div>
    </section>
  );
}

function BusinessRow({ business }: { business: BusinessSummary }) {
  const [isPending, startTransition] = useTransition();
  function makeDefault() {
    startTransition(async () => {
      await setDefaultBusinessAction(business.id);
    });
  }
  return (
    <div className="flex flex-wrap items-center gap-4 border-b border-zinc-900 bg-[#0a0a0a] px-5 py-4 last:border-b-0">
      <div className="min-w-[160px] text-sm text-zinc-100">{business.name}</div>
      <PlanChip plan={business.plan} />
      <div className="flex-1 text-xs text-zinc-500">
        {business.invoiceCount} invoice{business.invoiceCount === 1 ? "" : "s"}
        {" · "}
        {business.clientCount} client{business.clientCount === 1 ? "" : "s"}
        {" · "}
        {business.defaultCurrency}
      </div>
      {business.isDefault ? (
        <span className="rounded-full border border-zinc-800 px-2 py-0.5 text-[10px] uppercase tracking-widest text-zinc-500">
          Default
        </span>
      ) : (
        <button
          type="button"
          onClick={makeDefault}
          disabled={isPending}
          className="text-xs text-zinc-500 hover:text-zinc-200 disabled:opacity-60"
        >
          {isPending ? "…" : "Set default"}
        </button>
      )}
    </div>
  );
}

function PlanChip({ plan }: { plan: "free" | "pro" }) {
  const styles: Record<"free" | "pro", string> = {
    free: "border-zinc-800 text-zinc-500",
    pro: "border-emerald-900/60 text-emerald-300",
  };
  return (
    <span
      className={`rounded-full border bg-zinc-950 px-2 py-0.5 text-[10px] uppercase tracking-widest ${styles[plan]}`}
    >
      {plan}
    </span>
  );
}
