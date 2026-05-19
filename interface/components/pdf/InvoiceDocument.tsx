/* eslint-disable jsx-a11y/alt-text */
import {
  Document,
  Image,
  Link,
  Page,
  StyleSheet,
  Text,
  View,
} from "@react-pdf/renderer";
import { formatMoney } from "@/lib/money";
import type { InvoiceWithLineItems } from "@/lib/invoices";

// Using default Helvetica to avoid serverless font-loading complexity.
// Upgrade to Inter via Font.register() when we care about typography polish.

const c = {
  black: "#0a0a0a",
  ink: "#18181b",
  muted: "#71717a",
  line: "#e4e4e7",
  bg: "#fafafa",
};

const styles = StyleSheet.create({
  page: {
    padding: 40,
    fontSize: 10,
    color: c.ink,
    fontFamily: "Helvetica",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 28,
  },
  brandBlock: { flexDirection: "column", maxWidth: 280 },
  logo: { width: 64, height: 64, marginBottom: 12, objectFit: "contain" },
  brandName: {
    fontSize: 18,
    fontWeight: 700,
    color: c.black,
    marginBottom: 4,
  },
  brandMeta: { color: c.muted, lineHeight: 1.4 },
  metaBlock: { textAlign: "right", maxWidth: 220 },
  metaLabel: {
    color: c.muted,
    fontSize: 8,
    letterSpacing: 1.1,
    textTransform: "uppercase",
  },
  invoiceNumber: {
    fontSize: 14,
    fontWeight: 700,
    color: c.black,
    marginTop: 2,
    marginBottom: 12,
  },
  metaRow: { flexDirection: "row", justifyContent: "flex-end", marginTop: 4 },
  metaRowLabel: { color: c.muted, marginRight: 8 },
  block: { marginBottom: 24 },
  blockLabel: {
    color: c.muted,
    fontSize: 8,
    letterSpacing: 1.1,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  billTo: { lineHeight: 1.4 },
  billToName: { fontSize: 12, fontWeight: 700, color: c.black, marginBottom: 2 },
  table: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: c.line,
    marginBottom: 14,
  },
  tableHeader: {
    flexDirection: "row",
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderColor: c.line,
    backgroundColor: c.bg,
  },
  tableRow: {
    flexDirection: "row",
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderColor: c.line,
  },
  tableRowLast: {
    flexDirection: "row",
    paddingVertical: 8,
  },
  th: {
    color: c.muted,
    fontSize: 8,
    letterSpacing: 1.1,
    textTransform: "uppercase",
    paddingHorizontal: 4,
  },
  td: { paddingHorizontal: 4 },
  tdRight: { paddingHorizontal: 4, textAlign: "right" },
  totals: { alignSelf: "flex-end", width: 220 },
  totalsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  totalsRowBig: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderTopWidth: 1,
    borderColor: c.line,
    marginTop: 6,
  },
  totalsLabel: { color: c.muted },
  totalsValue: { color: c.ink },
  totalBig: { fontWeight: 700, fontSize: 12, color: c.black },
  footer: {
    marginTop: 32,
    paddingTop: 12,
    borderTopWidth: 1,
    borderColor: c.line,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  footerText: { color: c.muted, fontSize: 8 },
  attachmentList: { marginTop: 4, flexDirection: "column", gap: 2 },
  attachmentLink: {
    color: "#3f3f46",
    fontSize: 9,
    textDecoration: "underline",
  },
  lineNote: {
    marginTop: 2,
    color: c.muted,
    fontSize: 9,
    lineHeight: 1.4,
  },
  bankGrid: {
    marginTop: 6,
    flexDirection: "row",
    flexWrap: "wrap",
  },
  bankCell: {
    width: "50%",
    paddingRight: 12,
    paddingBottom: 8,
  },
  bankCellLabel: {
    color: c.muted,
    fontSize: 8,
    letterSpacing: 1.1,
    textTransform: "uppercase",
    marginBottom: 2,
  },
  bankCellValue: { color: c.ink, fontSize: 10 },
  bankCellMono: { fontFamily: "Courier" },
  walletRow: {
    marginTop: 6,
    marginBottom: 8,
  },
});

// Column widths (fractions of remaining space, tuned)
const col = {
  desc: { width: "48%" },
  qty: { width: "10%", textAlign: "right" as const },
  price: { width: "16%", textAlign: "right" as const },
  tax: { width: "10%", textAlign: "right" as const },
  total: { width: "16%", textAlign: "right" as const },
};

function addressLines(a: {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
}): string[] {
  const out: string[] = [];
  if (a.addressLine1) out.push(a.addressLine1);
  if (a.addressLine2) out.push(a.addressLine2);
  const cityLine = [a.city, a.region, a.postalCode].filter(Boolean).join(", ");
  if (cityLine) out.push(cityLine);
  if (a.country) out.push(a.country);
  return out;
}

export interface InvoicePdfData {
  invoice: InvoiceWithLineItems;
  client: {
    name: string;
    contactName: string | null;
    email: string | null;
    walletAddress: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    country: string | null;
  };
  business: {
    name: string;
    legalName: string | null;
    logoUrl: string | null;
    contactName: string | null;
    walletAddress: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    country: string | null;
    taxId: string | null;
    bankAccounts: Array<{
      label: string;
      accountHolder: string | null;
      bankName: string | null;
      accountNumber: string | null;
      ifsc: string | null;
      swift: string | null;
      iban: string | null;
      branchAddress: string | null;
      currency: string | null;
    }>;
  };
}

export function InvoiceDocument({
  invoice,
  client,
  business,
}: InvoicePdfData) {
  const fmt = (amount: string) => formatMoney(amount, invoice.currency);
  return (
    <Document
      title={invoice.invoiceNumber}
      author={business.name}
      subject={`Invoice ${invoice.invoiceNumber}`}
    >
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View style={styles.brandBlock}>
            {business.logoUrl ? (
              <Image src={business.logoUrl} style={styles.logo} />
            ) : null}
            <Text style={styles.brandName}>{business.name}</Text>
            {business.legalName && business.legalName !== business.name ? (
              <Text style={styles.brandMeta}>{business.legalName}</Text>
            ) : null}
            {addressLines(business).map((l, i) => (
              <Text key={i} style={styles.brandMeta}>
                {l}
              </Text>
            ))}
            {business.contactName ? (
              <Text style={styles.brandMeta}>Contact: {business.contactName}</Text>
            ) : null}
            {business.taxId ? (
              <Text style={styles.brandMeta}>Tax ID: {business.taxId}</Text>
            ) : null}
          </View>
          <View style={styles.metaBlock}>
            <Text style={styles.metaLabel}>Invoice</Text>
            <Text style={styles.invoiceNumber}>{invoice.invoiceNumber}</Text>
            <View style={styles.metaRow}>
              <Text style={styles.metaRowLabel}>Issue date</Text>
              <Text>{invoice.issueDate}</Text>
            </View>
            <View style={styles.metaRow}>
              <Text style={styles.metaRowLabel}>Due date</Text>
              <Text>{invoice.dueDate}</Text>
            </View>
          </View>
        </View>

        <View style={styles.block}>
          <Text style={styles.blockLabel}>Bill to</Text>
          <View style={styles.billTo}>
            <Text style={styles.billToName}>{client.name}</Text>
            {client.contactName ? (
              <Text style={styles.brandMeta}>Attn: {client.contactName}</Text>
            ) : null}
            {client.email ? (
              <Text style={styles.brandMeta}>{client.email}</Text>
            ) : null}
            {addressLines(client).map((l, i) => (
              <Text key={i} style={styles.brandMeta}>
                {l}
              </Text>
            ))}
            {client.walletAddress ? (
              <Text style={styles.brandMeta}>Wallet: {client.walletAddress}</Text>
            ) : null}
          </View>
        </View>

        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={{ ...styles.th, ...col.desc }}>Description</Text>
            <Text style={{ ...styles.th, ...col.qty }}>Qty</Text>
            <Text style={{ ...styles.th, ...col.price }}>Unit price</Text>
            <Text style={{ ...styles.th, ...col.tax }}>Tax</Text>
            <Text style={{ ...styles.th, ...col.total }}>Total</Text>
          </View>
          {invoice.lineItems.map((li, idx) => {
            const isLast = idx === invoice.lineItems.length - 1;
            const atts = (li.attachments ?? []) as Array<{
              label: string;
              url: string;
            }>;
            // wrap={false} keeps rows atomic in the normal case; but with many
            // attachment links a row can exceed page height, so allow wrap
            // when attachments are present.
            return (
              <View
                key={li.id}
                style={isLast ? styles.tableRowLast : styles.tableRow}
                wrap={atts.length > 0}
              >
                <View style={{ ...styles.td, ...col.desc }}>
                  <Text>{li.description}</Text>
                  {li.note ? (
                    <Text style={styles.lineNote}>{li.note}</Text>
                  ) : null}
                  {atts.length > 0 ? (
                    <View style={styles.attachmentList}>
                      {atts.map((a, i) => (
                        <Link key={i} src={a.url} style={styles.attachmentLink}>
                          ↗ {a.label}
                        </Link>
                      ))}
                    </View>
                  ) : null}
                </View>
                <Text style={{ ...styles.tdRight, ...col.qty }}>
                  {stripTrailingZeros(li.quantity)}
                </Text>
                <Text style={{ ...styles.tdRight, ...col.price }}>{fmt(li.unitPrice)}</Text>
                <Text style={{ ...styles.tdRight, ...col.tax }}>
                  {percent(li.taxRate)}
                </Text>
                <Text style={{ ...styles.tdRight, ...col.total }}>{fmt(li.lineTotal)}</Text>
              </View>
            );
          })}
        </View>

        <View style={styles.totals}>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>Subtotal</Text>
            <Text style={styles.totalsValue}>{fmt(invoice.subtotal)}</Text>
          </View>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>Tax</Text>
            <Text style={styles.totalsValue}>{fmt(invoice.taxTotal)}</Text>
          </View>
          <View style={styles.totalsRowBig}>
            <Text style={styles.totalBig}>Total</Text>
            <Text style={styles.totalBig}>{fmt(invoice.total)}</Text>
          </View>
        </View>

        {(invoice.notes?.trim() || invoice.terms?.trim()) && (
          <View style={{ marginTop: 24 }}>
            {invoice.notes?.trim() ? (
              <View style={styles.block}>
                <Text style={styles.blockLabel}>Notes</Text>
                <Text style={{ lineHeight: 1.5, color: c.ink }}>{invoice.notes}</Text>
              </View>
            ) : null}
            {invoice.terms?.trim() ? (
              <View style={styles.block}>
                <Text style={styles.blockLabel}>Terms</Text>
                <Text style={{ lineHeight: 1.5, color: c.ink }}>{invoice.terms}</Text>
              </View>
            ) : null}
          </View>
        )}

        {business.bankAccounts.length > 0 || business.walletAddress ? (
          <View style={{ marginTop: 24 }} wrap={false}>
            <Text style={styles.blockLabel}>Payment details</Text>
            {business.walletAddress ? (
              <View style={styles.walletRow}>
                <Text style={styles.bankCellLabel}>Wallet address</Text>
                <Text style={{ ...styles.bankCellValue, ...styles.bankCellMono }}>
                  {business.walletAddress}
                </Text>
              </View>
            ) : null}
            {business.bankAccounts.map((account, idx) => (
              <View key={idx} style={{ marginTop: idx === 0 ? 4 : 14 }}>
                {business.bankAccounts.length > 1 ? (
                  <Text style={{ ...styles.bankCellLabel, marginBottom: 4 }}>
                    {account.label}
                    {account.currency ? ` · ${account.currency}` : ""}
                  </Text>
                ) : null}
                <View style={styles.bankGrid}>
                  {account.accountHolder ? (
                    <BankCell label="Account holder" value={account.accountHolder} fullWidth />
                  ) : null}
                  {account.bankName ? (
                    <BankCell label="Bank" value={account.bankName} />
                  ) : null}
                  {account.accountNumber ? (
                    <BankCell label="Account number" value={account.accountNumber} mono />
                  ) : null}
                  {account.ifsc ? (
                    <BankCell label="IFSC" value={account.ifsc} mono />
                  ) : null}
                  {account.swift ? (
                    <BankCell label="SWIFT / BIC" value={account.swift} mono />
                  ) : null}
                  {account.iban ? (
                    <BankCell label="IBAN" value={account.iban} mono fullWidth />
                  ) : null}
                  {account.branchAddress ? (
                    <BankCell label="Branch address" value={account.branchAddress} fullWidth />
                  ) : null}
                </View>
              </View>
            ))}
          </View>
        ) : null}

        <View style={styles.footer}>
          <Text style={styles.footerText}>{invoice.invoiceNumber}</Text>
        </View>
      </Page>
    </Document>
  );
}

function BankCell({
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
    <View style={fullWidth ? { ...styles.bankCell, width: "100%", paddingRight: 0 } : styles.bankCell}>
      <Text style={styles.bankCellLabel}>{label}</Text>
      <Text style={mono ? { ...styles.bankCellValue, ...styles.bankCellMono } : styles.bankCellValue}>
        {value}
      </Text>
    </View>
  );
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
