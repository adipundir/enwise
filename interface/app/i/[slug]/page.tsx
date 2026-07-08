import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { desc } from "drizzle-orm";
import { businesses, clients, invoicePayments } from "@/lib/db/schema";
import { getInvoiceBySlug, markInvoiceViewed } from "@/lib/invoices";
import { addAmounts, formatMoney } from "@/lib/money";
import { CopyableField } from "./CopyableField";
import { PaidBadge } from "./PaidBadge";
import { PayWithWalletButton } from "./PayWithWalletButton";
import {
  paymentMethodEnabled,
  type DisplayOverrides,
} from "@/lib/invoices/displayResolver";
import {
  defaultSelectedChainId,
  resolveAcceptedChainIds,
} from "@/lib/web3/chain";
import { resolveInvoiceBankAccounts, toSnapshotShape } from "@/lib/bankAccounts";

const USDC_DECIMALS = 6;

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

  const [baseClient] = invoice.clientNameSnapshot
    ? [
        {
          name: invoice.clientNameSnapshot,
          contactName: invoice.clientContactNameSnapshot,
          email: invoice.clientEmailSnapshot,
          snapshot: invoice.clientAddressSnapshot,
        },
      ]
    : await db.select().from(clients).where(eq(clients.id, invoice.clientId));
  const [baseBusiness] = invoice.businessNameSnapshot
    ? [
        {
          name: invoice.businessNameSnapshot,
          legalName: invoice.businessLegalNameSnapshot,
          logoUrl: invoice.businessLogoUrlSnapshot,
          taxId: invoice.businessTaxIdSnapshot,
          contactName: invoice.businessContactNameSnapshot,
          evmWalletAddress: invoice.businessEvmWalletAddressSnapshot,
          starknetWalletAddress: invoice.businessStarknetWalletAddressSnapshot,
          aptosWalletAddress: invoice.businessAptosWalletAddressSnapshot,
          snapshot: invoice.businessAddressSnapshot,
        },
      ]
    : await db.select().from(businesses).where(eq(businesses.id, invoice.businessId));
  // Apply per-invoice atomic overrides on top of snapshot-or-live base.
  // Key presence in displayOverrides means override (null = explicit hide).
  const overrides = (invoice.displayOverrides ?? {}) as DisplayOverrides;
  const client = applyClientOverrides(baseClient, overrides.client);
  const business = applyBusinessOverrides(baseBusiness, overrides.business);
  // Bank accounts: snapshot (frozen array on finalize) wins, else resolve live.
  const bankAccounts = paymentMethodEnabled(invoice, "bank")
    ? await resolveBankAccountsForShare(invoice)
    : [];
  const cryptoOn = paymentMethodEnabled(invoice, "crypto_wallet");
  const businessEvmWallet = cryptoOn
    ? ((business && "evmWalletAddress" in business ? business.evmWalletAddress : null) ?? null)
    : null;
  const businessStarknetWallet = cryptoOn
    ? ((business && "starknetWalletAddress" in business ? business.starknetWalletAddress : null) ?? null)
    : null;
  const businessAptosWallet = cryptoOn
    ? ((business && "aptosWalletAddress" in business ? business.aptosWalletAddress : null) ?? null)
    : null;
  const businessContact =
    (business && "contactName" in business ? business.contactName : null) ?? null;

  // Wallet-pay button gate: invoice must be USD, unpaid, and the merchant must
  // have a 0x wallet on file. The payer picks which EVM chain to pay on from
  // the merchant's accepted set; all chains pay to the same evm wallet. We
  // read the chain config LIVE (per-invoice override → business set → the
  // business's preferred-chain fallback) so changing it affects all
  // outstanding invoices, matching merchant expectations.
  const [bizChainRow] = await db
    .select({
      paymentChainId: businesses.paymentChainId,
      acceptedChainIds: businesses.acceptedChainIds,
    })
    .from(businesses)
    .where(eq(businesses.id, invoice.businessId));
  const acceptedChainIds = resolveAcceptedChainIds({
    invoiceAccepted: invoice.acceptedChainIds,
    businessAccepted: bizChainRow?.acceptedChainIds ?? null,
    businessPreferred: bizChainRow?.paymentChainId ?? null,
  });
  const defaultChainId = defaultSelectedChainId(
    acceptedChainIds,
    bizChainRow?.paymentChainId ?? null,
  );

  // Latest on-chain payment for this invoice — used by the Paid badge to
  // show a clickable explorer link. Null when the invoice was marked paid
  // manually (no chain tx) or hasn't been paid at all.
  const [latestPayment] = invoice.status === "paid"
    ? await db
        .select({ txHash: invoicePayments.txHash, chainId: invoicePayments.chainId })
        .from(invoicePayments)
        .where(eq(invoicePayments.invoiceId, invoice.id))
        .orderBy(desc(invoicePayments.paidAt))
        .limit(1)
    : [];
  const outstandingDecimal = addAmounts(invoice.total, `-${invoice.amountPaid}`);
  const outstandingUsdcUnits = decimalToUsdcUnits(outstandingDecimal);
  const isEvmAddress = (s: string | null | undefined): s is `0x${string}` =>
    !!s && /^0x[a-fA-F0-9]{40}$/.test(s);
  const canPayWithWallet =
    invoice.status === "sent" &&
    invoice.currency.toUpperCase() === "USD" &&
    outstandingUsdcUnits > 0n &&
    isEvmAddress(businessEvmWallet);

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
    <main className="min-h-screen bg-zinc-100 px-3 py-6 text-zinc-900 sm:px-4 sm:py-10">
      <div className="mx-auto max-w-3xl">
        <header className="mb-4 flex flex-col gap-3 text-sm text-zinc-500 sm:mb-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            Invoice{" "}
            <span className="font-mono text-zinc-900">{invoice.invoiceNumber}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {invoice.status === "paid" ? (
              <PaidBadge
                slug={slug}
                txHash={latestPayment?.txHash}
                chainId={latestPayment?.chainId}
              />
            ) : (
              <>
                {canPayWithWallet && isEvmAddress(businessEvmWallet) ? (
                  <PayWithWalletButton
                    slug={slug}
                    merchantWallet={businessEvmWallet}
                    amountUsdcUnits={outstandingUsdcUnits.toString()}
                    amountDisplay={outstandingDecimal}
                    acceptedChainIds={acceptedChainIds}
                    defaultChainId={defaultChainId}
                  />
                ) : null}
              </>
            )}
            <a
              href={`/i/${slug}/pdf`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="size-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path
                  d="M2 10v3a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3M8 2v8m0 0 3-3m-3 3L5 7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Download PDF
            </a>
          </div>
        </header>

        <article className="relative rounded-2xl bg-white p-5 shadow-sm ring-1 ring-zinc-200 sm:p-10">
          {invoice.status === "void" ? (
            <div className="mb-6 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
              <svg
                viewBox="0 0 20 20"
                className="mt-0.5 size-5 shrink-0 text-red-600"
                fill="currentColor"
                aria-hidden
              >
                <path
                  fillRule="evenodd"
                  d="M10 1.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM10 6a1 1 0 0 1 1 1v3.5a1 1 0 1 1-2 0V7a1 1 0 0 1 1-1Zm0 7.25a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Z"
                  clipRule="evenodd"
                />
              </svg>
              <div>
                <div className="font-semibold">This invoice has been voided.</div>
                <div className="mt-0.5 text-red-800">
                  No payment is due. If you have already paid, please contact the issuer.
                </div>
              </div>
            </div>
          ) : null}
          <section className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
            <div>
              {business?.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={business.logoUrl}
                  alt={business.name ?? ""}
                  className="mb-4 h-14 w-auto object-contain"
                />
              ) : null}
              <div className="text-lg font-semibold">{business?.name}</div>
              {business &&
              "legalName" in business &&
              business.legalName &&
              business.legalName !== business.name ? (
                <div className="text-sm text-zinc-600">{business.legalName}</div>
              ) : null}
              <AddressLines lines={businessAddr} />
              {businessContact ? (
                <div className="mt-1 text-xs text-zinc-500">
                  Contact: {businessContact}
                </div>
              ) : null}
              {business && "taxId" in business && business.taxId ? (
                <div className="mt-1 text-xs text-zinc-500">Tax ID: {business.taxId}</div>
              ) : null}
            </div>
            <div className="sm:text-right">
              <div className="text-[10px] uppercase tracking-widest text-zinc-500">
                Invoice
              </div>
              <div className="font-mono text-xl font-semibold">
                {invoice.invoiceNumber}
              </div>
              <dl className="mt-4 space-y-1 text-sm">
                <DlRow label="Issue date" value={invoice.issueDate} />
                <DlRow label="Due date" value={invoice.dueDate} />
              </dl>
            </div>
          </section>

          <section className="mt-8 sm:mt-10">
            <div className="text-[10px] uppercase tracking-widest text-zinc-500">
              Bill to
            </div>
            <div className="mt-2">
              <div className="font-medium">{client?.name}</div>
              {client && "contactName" in client && client.contactName ? (
                <div className="text-sm text-zinc-600">Attn: {client.contactName}</div>
              ) : null}
              {client?.email ? (
                <div className="text-sm text-zinc-600">{client.email}</div>
              ) : null}
              <AddressLines lines={clientAddr} />
            </div>
          </section>

          {/* Line items: stacked cards on mobile, table on sm+ */}
          <section className="mt-8 sm:mt-10">
            {/* Mobile: stacked cards */}
            <ul className="space-y-3 sm:hidden">
              {invoice.lineItems.map((li) => {
                const atts = (li.attachments ?? []) as Array<{
                  label: string;
                  url: string;
                }>;
                return (
                  <li
                    key={li.id}
                    className="rounded-xl ring-1 ring-zinc-200 px-4 py-3 text-sm"
                  >
                    <div className="font-medium">{li.description}</div>
                    {li.note ? (
                      <div className="mt-1 text-xs leading-relaxed text-zinc-500 whitespace-pre-wrap">
                        {li.note}
                      </div>
                    ) : null}
                    {atts.length > 0 ? (
                      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                        {atts.map((a, i) => (
                          <li key={i}>
                            <a
                              href={a.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-zinc-600 underline underline-offset-2 hover:text-zinc-900"
                            >
                              <AttachmentIcon />
                              {a.label}
                            </a>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-zinc-100 pt-3 text-xs">
                      <CardCell label="Qty" value={stripTrailingZeros(li.quantity)} />
                      <CardCell label="Unit price" value={fmt(li.unitPrice)} />
                      <CardCell label="Tax" value={percent(li.taxRate)} />
                      <CardCell label="Total" value={fmt(li.lineTotal)} bold />
                    </dl>
                  </li>
                );
              })}
            </ul>

            {/* sm+: traditional table */}
            <div className="hidden overflow-hidden rounded-xl ring-1 ring-zinc-200 sm:block">
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
                  {invoice.lineItems.map((li) => {
                    const atts = (li.attachments ?? []) as Array<{
                      label: string;
                      url: string;
                    }>;
                    return (
                      <tr key={li.id}>
                        <td className="px-4 py-3">
                          <div>{li.description}</div>
                          {li.note ? (
                            <div className="mt-1 text-xs leading-relaxed text-zinc-500 whitespace-pre-wrap">
                              {li.note}
                            </div>
                          ) : null}
                          {atts.length > 0 ? (
                            <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                              {atts.map((a, i) => (
                                <li key={i}>
                                  <a
                                    href={a.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 text-zinc-600 underline underline-offset-2 hover:text-zinc-900"
                                  >
                                    <AttachmentIcon />
                                    {a.label}
                                  </a>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 text-right align-top">
                          {stripTrailingZeros(li.quantity)}
                        </td>
                        <td className="px-4 py-3 text-right align-top">{fmt(li.unitPrice)}</td>
                        <td className="px-4 py-3 text-right align-top">{percent(li.taxRate)}</td>
                        <td className="px-4 py-3 text-right align-top">{fmt(li.lineTotal)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="mt-6 flex sm:justify-end">
            <dl className="w-full space-y-1 text-sm sm:w-72">
              <DlRow label="Subtotal" value={fmt(invoice.subtotal)} />
              <DlRow label="Tax" value={fmt(invoice.taxTotal)} />
              <div className="mt-3 flex justify-between border-t border-zinc-200 pt-3 text-base font-semibold">
                <dt>Total</dt>
                <dd>{fmt(invoice.total)}</dd>
              </div>
            </dl>
          </section>

          {(invoice.notes?.trim() || invoice.terms?.trim()) && (
            <section className="mt-10 space-y-6 text-sm text-zinc-700">
              {invoice.notes?.trim() && (
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-zinc-500">
                    Notes
                  </div>
                  <p className="mt-2 whitespace-pre-wrap">{invoice.notes}</p>
                </div>
              )}
              {invoice.terms?.trim() && (
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-zinc-500">
                    Terms
                  </div>
                  <p className="mt-2 whitespace-pre-wrap">{invoice.terms}</p>
                </div>
              )}
            </section>
          )}

          {bankAccounts.length > 0 ||
          businessEvmWallet ||
          businessStarknetWallet ||
          businessAptosWallet ? (
            <section className="mt-10 space-y-6">
              <div className="text-[10px] uppercase tracking-widest text-zinc-500">
                Payment details
              </div>
              {businessEvmWallet ? (
                <div className="flex flex-col gap-0.5 text-sm">
                  <dt className="text-[10px] uppercase tracking-widest text-zinc-500">
                    EVM (USDC on Base / Arbitrum, USDT on Ethereum)
                  </dt>
                  <dd>
                    <CopyableField value={businessEvmWallet} mono />
                  </dd>
                </div>
              ) : null}
              {businessStarknetWallet ? (
                <div className="flex flex-col gap-0.5 text-sm">
                  <dt className="text-[10px] uppercase tracking-widest text-zinc-500">
                    Starknet (USDC)
                  </dt>
                  <dd>
                    <CopyableField value={businessStarknetWallet} mono />
                  </dd>
                </div>
              ) : null}
              {businessAptosWallet ? (
                <div className="flex flex-col gap-0.5 text-sm">
                  <dt className="text-[10px] uppercase tracking-widest text-zinc-500">
                    Aptos (USDC)
                  </dt>
                  <dd>
                    <CopyableField value={businessAptosWallet} mono />
                  </dd>
                </div>
              ) : null}
              {bankAccounts.map((account, idx) => (
                <div key={idx}>
                  {bankAccounts.length > 1 ? (
                    <div className="mb-2 text-[11px] uppercase tracking-widest text-zinc-700">
                      {account.label}
                      {account.currency ? (
                        <span className="ml-2 text-zinc-400">· {account.currency}</span>
                      ) : null}
                    </div>
                  ) : null}
                  <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
                    {account.accountHolder ? (
                      <BankRow label="Account holder" value={account.accountHolder} fullWidth />
                    ) : null}
                    {account.bankName ? (
                      <BankRow label="Bank" value={account.bankName} />
                    ) : null}
                    {account.accountNumber ? (
                      <BankRow label="Account number" value={account.accountNumber} mono />
                    ) : null}
                    {account.ifsc ? (
                      <BankRow label="IFSC" value={account.ifsc} mono />
                    ) : null}
                    {account.swift ? (
                      <BankRow label="SWIFT / BIC" value={account.swift} mono />
                    ) : null}
                    {account.achRouting ? (
                      <BankRow label="ACH routing" value={account.achRouting} mono />
                    ) : null}
                    {account.fedwireRouting ? (
                      <BankRow label="Fedwire routing" value={account.fedwireRouting} mono />
                    ) : null}
                    {account.iban ? (
                      <BankRow label="IBAN" value={account.iban} mono fullWidth />
                    ) : null}
                    {account.branchAddress ? (
                      <BankRow label="Branch address" value={account.branchAddress} fullWidth />
                    ) : null}
                  </dl>
                </div>
              ))}
            </section>
          ) : null}

          <footer className="mt-10 border-t border-zinc-200 pt-4 text-xs text-zinc-500">
            {invoice.invoiceNumber}
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

function CardCell({
  label,
  value,
  bold,
}: {
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-zinc-500">{label}</dt>
      <dd className={bold ? "font-semibold text-zinc-900" : "text-zinc-700"}>
        {value}
      </dd>
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

type BankAccountForRender = {
  label: string;
  accountHolder: string | null;
  bankName: string | null;
  accountNumber: string | null;
  ifsc: string | null;
  swift: string | null;
  iban: string | null;
  achRouting: string | null;
  fedwireRouting: string | null;
  branchAddress: string | null;
  currency: string | null;
};

type BankAccountSnapshotEntry = {
  id?: string;
  label?: string;
  account_holder?: string | null;
  bank_name?: string | null;
  account_number?: string | null;
  ifsc?: string | null;
  swift?: string | null;
  iban?: string | null;
  ach_routing?: string | null;
  fedwire_routing?: string | null;
  branch_address?: string | null;
  currency?: string | null;
};

type BaseBusiness = {
  name?: string | null;
  legalName?: string | null;
  logoUrl?: string | null;
  taxId?: string | null;
  contactName?: string | null;
  evmWalletAddress?: string | null;
  starknetWalletAddress?: string | null;
  aptosWalletAddress?: string | null;
  snapshot?: unknown;
  // address fields appear directly on the live row
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
};

type BaseClient = {
  name?: string | null;
  contactName?: string | null;
  email?: string | null;
  snapshot?: unknown;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
};

/**
 * Apply per-invoice overrides on top of snapshot-or-live business. Address
 * and bank_details overrides replace the corresponding snapshot JSON entirely
 * (no per-key merging). To override a single bank field, send the whole
 * bank_details object.
 */
function applyBusinessOverrides(
  base: BaseBusiness | undefined,
  ov: DisplayOverrides["business"] | undefined,
): BaseBusiness | undefined {
  if (!base) return base;
  if (!ov) return base;
  const out: BaseBusiness = { ...base };
  if ("name" in ov) out.name = ov.name;
  if ("legal_name" in ov) out.legalName = ov.legal_name;
  if ("tax_id" in ov) out.taxId = ov.tax_id;
  if ("contact_name" in ov) out.contactName = ov.contact_name;
  if ("evm_wallet_address" in ov) out.evmWalletAddress = ov.evm_wallet_address;
  if ("starknet_wallet_address" in ov) out.starknetWalletAddress = ov.starknet_wallet_address;
  if ("aptos_wallet_address" in ov) out.aptosWalletAddress = ov.aptos_wallet_address;
  if ("logo_url" in ov) out.logoUrl = ov.logo_url;
  if ("address" in ov) {
    // Replace the snapshot so buildAddressLines reads the override; also
    // clear the live fields so they don't show through if override is null.
    out.snapshot = ov.address ?? null;
    out.addressLine1 = null;
    out.addressLine2 = null;
    out.city = null;
    out.region = null;
    out.postalCode = null;
    out.country = null;
  }
  // `bank_details` display override is no longer supported — use the
  // accepted_bank_account_ids picker on update_invoice (or edit the bank
  // account itself via update_bank_account) instead.
  return out;
}

function applyClientOverrides(
  base: BaseClient | undefined,
  ov: DisplayOverrides["client"] | undefined,
): BaseClient | undefined {
  if (!base) return base;
  if (!ov) return base;
  const out: BaseClient = { ...base };
  if ("name" in ov) out.name = ov.name;
  if ("contact_name" in ov) out.contactName = ov.contact_name;
  if ("email" in ov) out.email = ov.email;
  if ("address" in ov) {
    out.snapshot = ov.address ?? null;
    out.addressLine1 = null;
    out.addressLine2 = null;
    out.city = null;
    out.region = null;
    out.postalCode = null;
    out.country = null;
  }
  return out;
}

async function resolveBankAccountsForShare(invoice: {
  businessId: string;
  businessBankAccountsSnapshot: unknown;
  acceptedBankAccountIds: string[] | null;
}): Promise<BankAccountForRender[]> {
  const snap = invoice.businessBankAccountsSnapshot as
    | BankAccountSnapshotEntry[]
    | null;
  if (snap && Array.isArray(snap) && snap.length > 0) {
    return snap.map(snapshotEntryToBankAccount);
  }
  const live = await resolveInvoiceBankAccounts(
    invoice.businessId,
    invoice.acceptedBankAccountIds,
  );
  return live.map(toSnapshotShape).map(snapshotEntryToBankAccount);
}

function snapshotEntryToBankAccount(snap: BankAccountSnapshotEntry): BankAccountForRender {
  return {
    label: snap.label ?? "Bank account",
    accountHolder: snap.account_holder ?? null,
    bankName: snap.bank_name ?? null,
    accountNumber: snap.account_number ?? null,
    ifsc: snap.ifsc ?? null,
    swift: snap.swift ?? null,
    iban: snap.iban ?? null,
    achRouting: snap.ach_routing ?? null,
    fedwireRouting: snap.fedwire_routing ?? null,
    branchAddress: snap.branch_address ?? null,
    currency: snap.currency ?? null,
  };
}

function BankRow({
  label,
  value,
  mono,
  fullWidth,
}: {
  label: string;
  value: string;
  mono?: boolean;
  fullWidth?: boolean;
}) {
  return (
    <div className={`flex flex-col gap-0.5${fullWidth ? " sm:col-span-2" : ""}`}>
      <dt className="text-[10px] uppercase tracking-widest text-zinc-500">
        {label}
      </dt>
      <dd>
        <CopyableField value={value} mono={mono} />
      </dd>
    </div>
  );
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

function decimalToUsdcUnits(decimal: string): bigint {
  const negative = decimal.startsWith("-");
  const body = negative ? decimal.slice(1) : decimal;
  const [intPart, decPart = ""] = body.split(".");
  const padded = decPart.padEnd(USDC_DECIMALS, "0").slice(0, USDC_DECIMALS);
  const units = BigInt(intPart || "0") * 1_000_000n + BigInt(padded || "0");
  return negative ? -units : units;
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

function AttachmentIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path
        d="M10.5 3.5 5.75 8.25a2.5 2.5 0 1 0 3.536 3.536l4.243-4.243a4 4 0 1 0-5.657-5.657L3.629 6.128"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
