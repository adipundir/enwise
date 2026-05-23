import { renderToBuffer, renderToStream, type DocumentProps } from "@react-pdf/renderer";
import { createElement, type ReactElement } from "react";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { businesses, clients, type Business, type Client } from "@/lib/db/schema";
import type { InvoiceWithLineItems } from "@/lib/invoices";
import { resolveInvoiceBankAccounts, toSnapshotShape } from "@/lib/bankAccounts";
import { InvoiceDocument, type InvoicePdfData } from "@/components/pdf/InvoiceDocument";
import {
  paymentMethodEnabled,
  type DisplayOverrides,
} from "@/lib/invoices/displayResolver";

type BankAccountSnapshot = {
  id?: string;
  label: string;
  account_holder: string | null;
  bank_name: string | null;
  account_number: string | null;
  ifsc: string | null;
  swift: string | null;
  iban: string | null;
  ach_routing?: string | null;
  fedwire_routing?: string | null;
  branch_address: string | null;
  currency?: string | null;
};

/**
 * Pick a scalar override > snapshot > live. `hasKey` distinguishes "key
 * absent" (fall through) from "key present with null" (explicit hide).
 */
function pickScalar<T>(
  ov: Record<string, unknown> | undefined,
  key: string,
  snap: T | null | undefined,
  live: T | null | undefined,
): T | null {
  if (ov && key in ov) return (ov[key] as T | null) ?? null;
  return (snap ?? live ?? null) as T | null;
}

/**
 * Render an invoice to a PDF Node stream.
 *
 * Preference order for client/business fields:
 *   1. Snapshot fields on the invoice (captured on finalize/send)
 *   2. Live rows from the DB (for drafts. there's no snapshot yet)
 */
export async function renderInvoicePdf(
  invoice: InvoiceWithLineItems,
): Promise<NodeJS.ReadableStream> {
  const data = await buildInvoicePdfData(invoice);
  const element = createElement(
    InvoiceDocument,
    data,
  ) as unknown as ReactElement<DocumentProps>;
  return renderToStream(element);
}

/** Buffer variant — used by sendInvoiceByEmail so we can attach the PDF
 *  to the outbound Resend email without piping a stream. */
export async function renderInvoiceBuffer(
  invoice: InvoiceWithLineItems,
): Promise<Buffer> {
  const data = await buildInvoicePdfData(invoice);
  const element = createElement(
    InvoiceDocument,
    data,
  ) as unknown as ReactElement<DocumentProps>;
  return renderToBuffer(element);
}

export async function buildInvoicePdfData(
  invoice: InvoiceWithLineItems,
): Promise<InvoicePdfData> {
  let client: Client | null = null;
  let business: Business | null = null;

  if (!invoice.clientNameSnapshot) {
    const [row] = await db.select().from(clients).where(eq(clients.id, invoice.clientId));
    client = row ?? null;
  }
  if (!invoice.businessNameSnapshot) {
    const [row] = await db.select().from(businesses).where(eq(businesses.id, invoice.businessId));
    business = row ?? null;
  }

  const clientSnapshot = (invoice.clientAddressSnapshot as ClientAddressSnapshot | null) ?? null;
  const businessSnapshot = (invoice.businessAddressSnapshot as ClientAddressSnapshot | null) ?? null;
  const bankAccountsSnapshot = (invoice.businessBankAccountsSnapshot as BankAccountSnapshot[] | null) ?? null;

  const overrides = (invoice.displayOverrides ?? {}) as DisplayOverrides;
  const bizOv = overrides.business as Record<string, unknown> | undefined;
  const cliOv = overrides.client as Record<string, unknown> | undefined;

  // Address overrides replace the entire snapshot block.
  const clientAddrSrc =
    cliOv && "address" in cliOv
      ? (cliOv.address as ClientAddressSnapshot | null) ?? null
      : clientSnapshot;
  const businessAddrSrc =
    bizOv && "address" in bizOv
      ? (bizOv.address as ClientAddressSnapshot | null) ?? null
      : businessSnapshot;
  // When the override drops the address, also drop the live fallback so the
  // override actually takes effect (otherwise live fields shine through).
  const clientAddrLive = cliOv && "address" in cliOv ? null : client;
  const businessAddrLive = bizOv && "address" in bizOv ? null : business;

  const cryptoOn = paymentMethodEnabled(invoice, "crypto_wallet");

  return {
    invoice,
    client: {
      name: pickScalar(cliOv, "name", invoice.clientNameSnapshot, client?.name) ??
        "(unknown client)",
      contactName: pickScalar(
        cliOv,
        "contact_name",
        invoice.clientContactNameSnapshot,
        client?.contactName,
      ),
      email: pickScalar(cliOv, "email", invoice.clientEmailSnapshot, client?.email),
      addressLine1: clientAddrSrc?.line1 ?? clientAddrLive?.addressLine1 ?? null,
      addressLine2: clientAddrSrc?.line2 ?? clientAddrLive?.addressLine2 ?? null,
      city: clientAddrSrc?.city ?? clientAddrLive?.city ?? null,
      region: clientAddrSrc?.region ?? clientAddrLive?.region ?? null,
      postalCode: clientAddrSrc?.postal_code ?? clientAddrLive?.postalCode ?? null,
      country: clientAddrSrc?.country ?? clientAddrLive?.country ?? null,
    },
    business: {
      name: pickScalar(bizOv, "name", invoice.businessNameSnapshot, business?.name) ??
        "(unknown business)",
      legalName: pickScalar(
        bizOv,
        "legal_name",
        invoice.businessLegalNameSnapshot,
        business?.legalName,
      ),
      logoUrl: pickScalar(
        bizOv,
        "logo_url",
        invoice.businessLogoUrlSnapshot,
        business?.logoUrl,
      ),
      contactName: pickScalar(
        bizOv,
        "contact_name",
        invoice.businessContactNameSnapshot,
        business?.contactName,
      ),
      evmWalletAddress: cryptoOn
        ? pickScalar(
            bizOv,
            "evm_wallet_address",
            invoice.businessEvmWalletAddressSnapshot,
            business?.evmWalletAddress,
          )
        : null,
      starknetWalletAddress: cryptoOn
        ? pickScalar(
            bizOv,
            "starknet_wallet_address",
            invoice.businessStarknetWalletAddressSnapshot,
            business?.starknetWalletAddress,
          )
        : null,
      aptosWalletAddress: cryptoOn
        ? pickScalar(
            bizOv,
            "aptos_wallet_address",
            invoice.businessAptosWalletAddressSnapshot,
            business?.aptosWalletAddress,
          )
        : null,
      addressLine1: businessAddrSrc?.line1 ?? businessAddrLive?.addressLine1 ?? null,
      addressLine2: businessAddrSrc?.line2 ?? businessAddrLive?.addressLine2 ?? null,
      city: businessAddrSrc?.city ?? businessAddrLive?.city ?? null,
      region: businessAddrSrc?.region ?? businessAddrLive?.region ?? null,
      postalCode: businessAddrSrc?.postal_code ?? businessAddrLive?.postalCode ?? null,
      country: businessAddrSrc?.country ?? businessAddrLive?.country ?? null,
      taxId: pickScalar(bizOv, "tax_id", invoice.businessTaxIdSnapshot, business?.taxId),
      bankAccounts: paymentMethodEnabled(invoice, "bank")
        ? await resolveBankAccountsForInvoice(invoice, bankAccountsSnapshot)
        : [],
    },
  };
}

async function resolveBankAccountsForInvoice(
  invoice: InvoiceWithLineItems,
  snapshot: BankAccountSnapshot[] | null,
): Promise<InvoicePdfData["business"]["bankAccounts"]> {
  // Snapshot wins when present (frozen at finalize).
  if (snapshot && snapshot.length > 0) {
    return snapshot.map(snapshotToBankAccount);
  }
  // Live fallback — for drafts.
  const live = await resolveInvoiceBankAccounts(
    invoice.businessId,
    invoice.acceptedBankAccountIds ?? null,
  );
  return live.map(toSnapshotShape).map(snapshotToBankAccount);
}

function snapshotToBankAccount(snap: BankAccountSnapshot): {
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
} {
  return {
    label: snap.label,
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

interface ClientAddressSnapshot {
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
}
