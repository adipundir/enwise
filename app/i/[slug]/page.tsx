import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { businesses, clients } from "@/lib/db/schema";
import { getInvoiceBySlug, markInvoiceViewed } from "@/lib/invoices";
import { formatMoney } from "@/lib/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

type Params = Promise<{ slug: string }>;

export default async function PublicInvoicePage({ params }: { params: Params }) {
  const { slug } = await params;
  const invoice = await getInvoiceBySlug(slug);
  if (!invoice) notFound();

  const [client] = invoice.clientNameSnapshot
    ? [
        {
          name: invoice.clientNameSnapshot,
          email: invoice.clientEmailSnapshot,
          snapshot: invoice.clientAddressSnapshot,
        },
      ]
    : await db.select().from(clients).where(eq(clients.id, invoice.clientId));
  const [business] = invoice.businessNameSnapshot
    ? [
        {
          name: invoice.businessNameSnapshot,
          logoUrl: invoice.businessLogoUrlSnapshot,
          taxId: null as string | null,
          snapshot: invoice.businessAddressSnapshot,
        },
      ]
    : await db.select().from(businesses).where(eq(businesses.id, invoice.businessId));

  after(async () => {
    try {
      await markInvoiceViewed(slug);
    } catch {
      // fire-and-forget; don't surface errors on view stamp
    }
  });

  const fmt = (amount: string) => formatMoney(amount, invoice.currency);

  const clientAddr = buildAddressLines(client as AddressSource | undefined);
  const businessAddr = buildAddressLines(business as AddressSource | undefined);

  return (
    <main className="min-h-screen bg-zinc-100 px-4 py-10 text-zinc-900">
      <div className="mx-auto max-w-3xl">
        <header className="flex items-center justify-between mb-6 text-sm text-zinc-500">
          <div>
            Invoice{" "}
            <span className="font-mono text-zinc-900">{invoice.invoiceNumber}</span>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={`/i/${slug}/pdf`}
              className="rounded-md bg-zinc-900 text-zinc-50 px-3.5 py-1.5 hover:bg-zinc-800"
            >
              Download PDF
            </a>
            <button
              type="button"
              disabled
              title="Online payment coming soon"
              className="cursor-not-allowed rounded-md border border-zinc-300 bg-white px-3.5 py-1.5 text-zinc-400"
            >
              Pay here (coming soon)
            </button>
          </div>
        </header>

        <article className="rounded-2xl bg-white p-10 shadow-sm ring-1 ring-zinc-200">
          <section className="flex items-start justify-between gap-6">
            <div>
              {business?.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={business.logoUrl}
                  alt={business.name}
                  className="mb-4 h-14 w-auto object-contain"
                />
              ) : null}
              <div className="text-lg font-semibold">{business?.name}</div>
              <AddressLines lines={businessAddr} />
              {business && "taxId" in business && business.taxId ? (
                <div className="mt-1 text-xs text-zinc-500">Tax ID: {business.taxId}</div>
              ) : null}
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-widest text-zinc-500">
                Invoice
              </div>
              <div className="font-mono text-xl font-semibold">
                {invoice.invoiceNumber}
              </div>
              <dl className="mt-4 space-y-1 text-sm">
                <DlRow label="Issue date" value={invoice.issueDate} />
                <DlRow label="Due date" value={invoice.dueDate} />
                <DlRow
                  label="Status"
                  value={
                    <span className="uppercase tracking-widest text-[10px] rounded-full border border-zinc-300 px-2 py-0.5 text-zinc-700">
                      {invoice.status}
                    </span>
                  }
                />
              </dl>
            </div>
          </section>

          <section className="mt-10">
            <div className="text-[10px] uppercase tracking-widest text-zinc-500">
              Bill to
            </div>
            <div className="mt-2">
              <div className="font-medium">{client?.name}</div>
              {client?.email ? (
                <div className="text-sm text-zinc-600">{client.email}</div>
              ) : null}
              <AddressLines lines={clientAddr} />
            </div>
          </section>

          <section className="mt-10 overflow-hidden rounded-xl ring-1 ring-zinc-200">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left text-[10px] uppercase tracking-widest text-zinc-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Description</th>
                  <th className="px-4 py-2 font-medium text-right">Qty</th>
                  <th className="px-4 py-2 font-medium text-right">Unit price</th>
                  <th className="px-4 py-2 font-medium text-right">Tax</th>
                  <th className="px-4 py-2 font-medium text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200">
                {invoice.lineItems.map((li) => (
                  <tr key={li.id}>
                    <td className="px-4 py-3">{li.description}</td>
                    <td className="px-4 py-3 text-right">
                      {stripTrailingZeros(li.quantity)}
                    </td>
                    <td className="px-4 py-3 text-right">{fmt(li.unitPrice)}</td>
                    <td className="px-4 py-3 text-right">{percent(li.taxRate)}</td>
                    <td className="px-4 py-3 text-right">{fmt(li.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="mt-6 flex justify-end">
            <dl className="w-72 space-y-1 text-sm">
              <DlRow label="Subtotal" value={fmt(invoice.subtotal)} />
              <DlRow label="Tax" value={fmt(invoice.taxTotal)} />
              <div className="mt-3 flex justify-between border-t border-zinc-200 pt-3 text-base font-semibold">
                <dt>Total</dt>
                <dd>{fmt(invoice.total)}</dd>
              </div>
            </dl>
          </section>

          {(invoice.notes || invoice.terms) && (
            <section className="mt-10 space-y-6 text-sm text-zinc-700">
              {invoice.notes && (
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-zinc-500">
                    Notes
                  </div>
                  <p className="mt-2 whitespace-pre-wrap">{invoice.notes}</p>
                </div>
              )}
              {invoice.terms && (
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-zinc-500">
                    Terms
                  </div>
                  <p className="mt-2 whitespace-pre-wrap">{invoice.terms}</p>
                </div>
              )}
            </section>
          )}

          <footer className="mt-10 flex items-center justify-between border-t border-zinc-200 pt-4 text-xs text-zinc-500">
            <span>{invoice.invoiceNumber}</span>
            <span>Powered by envoice</span>
          </footer>
        </article>
      </div>
    </main>
  );
}

function DlRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-6">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="text-zinc-900">{value}</dd>
    </div>
  );
}

function AddressLines({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="mt-1 space-y-0.5 text-sm text-zinc-600">
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  );
}

interface AddressSource {
  name?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
  snapshot?: unknown;
}

function buildAddressLines(src: AddressSource | undefined): string[] {
  if (!src) return [];
  const snap = src.snapshot as
    | {
        line1?: string | null;
        line2?: string | null;
        city?: string | null;
        region?: string | null;
        postal_code?: string | null;
        country?: string | null;
      }
    | null
    | undefined;
  const a1 = snap?.line1 ?? src.addressLine1 ?? null;
  const a2 = snap?.line2 ?? src.addressLine2 ?? null;
  const city = snap?.city ?? src.city ?? null;
  const region = snap?.region ?? src.region ?? null;
  const pc = snap?.postal_code ?? src.postalCode ?? null;
  const country = snap?.country ?? src.country ?? null;
  const out: string[] = [];
  if (a1) out.push(a1);
  if (a2) out.push(a2);
  const cityLine = [city, region, pc].filter(Boolean).join(", ");
  if (cityLine) out.push(cityLine);
  if (country) out.push(country);
  return out;
}

function stripTrailingZeros(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "");
}

function percent(rate: string): string {
  const n = Number(rate);
  if (!Number.isFinite(n) || n === 0) return "—";
  return `${(n * 100).toFixed(2).replace(/\.00$/, "")}%`;
}
