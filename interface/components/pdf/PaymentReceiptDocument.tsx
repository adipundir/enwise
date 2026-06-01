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

const c = {
  black: "#0a0a0a",
  ink: "#18181b",
  muted: "#71717a",
  line: "#e4e4e7",
  bg: "#fafafa",
  accent: "#059669", // emerald-600
};

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 10, color: c.ink, fontFamily: "Inter" },
  header: { flexDirection: "row", justifyContent: "space-between", marginBottom: 28 },
  brandBlock: { flexDirection: "column", maxWidth: 280 },
  logo: { width: 64, height: 64, marginBottom: 12, objectFit: "contain" },
  brandName: { fontSize: 18, fontWeight: 700, color: c.black, marginBottom: 4 },
  brandMeta: { color: c.muted, lineHeight: 1.4 },
  metaBlock: { textAlign: "right", maxWidth: 220 },
  kicker: {
    color: c.muted,
    fontSize: 8,
    letterSpacing: 1.1,
    textTransform: "uppercase",
  },
  docTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: c.accent,
    marginTop: 2,
    marginBottom: 12,
    letterSpacing: 1.5,
  },
  metaRow: { flexDirection: "row", justifyContent: "flex-end", marginTop: 4 },
  metaRowLabel: { color: c.muted, marginRight: 8 },
  amountBlock: {
    marginVertical: 24,
    padding: 24,
    backgroundColor: c.bg,
    borderRadius: 6,
    borderLeftWidth: 3,
    borderLeftColor: c.accent,
  },
  amountLabel: {
    color: c.muted,
    fontSize: 8,
    letterSpacing: 1.1,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  amount: { fontSize: 28, fontWeight: 700, color: c.black, marginBottom: 2 },
  paidOn: { color: c.muted },
  twoCol: { flexDirection: "row", gap: 32, marginBottom: 24 },
  col: { flex: 1 },
  blockLabel: {
    color: c.muted,
    fontSize: 8,
    letterSpacing: 1.1,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  fieldRow: { marginBottom: 8 },
  fieldKey: { color: c.muted, fontSize: 8, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 2 },
  fieldVal: { color: c.ink, lineHeight: 1.4 },
  txMono: { fontFamily: "Courier", fontSize: 9, color: c.ink },
  txLink: { fontFamily: "Courier", fontSize: 9, color: c.accent, textDecoration: "underline" },
  footer: {
    marginTop: 32,
    paddingTop: 12,
    borderTopWidth: 1,
    borderColor: c.line,
  },
  footerName: { fontSize: 11, fontWeight: 700, color: c.black, marginBottom: 8 },
  footerMeta: { color: c.muted, lineHeight: 0.75 },
});

export interface PaymentReceiptData {
  receipt: {
    /** Document number — reuses the invoice number so reconciliation is trivial. */
    invoiceNumber: string;
    /** ISO datetime of the on-chain confirmation. */
    paidAt: Date;
    amount: string;
    currency: string;
  };
  invoice: {
    issueDate: string;
    total: string;
    currency: string;
  };
  business: {
    name: string;
    legalName: string | null;
    logoUrl: string | null;
    addressLines: string[];
    taxId: string | null;
  };
  paidBy: {
    name: string;
    addressLines: string[];
  };
  payment: {
    methodLabel: string;
    chainName: string;
    txHash: string;
    txExplorerUrl: string | null;
    payerAddress: string | null;
  };
}

export function PaymentReceiptDocument({
  receipt,
  invoice,
  business,
  paidBy,
  payment,
}: PaymentReceiptData) {
  const paidOn = receipt.paidAt.toISOString().slice(0, 10);
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View style={styles.brandBlock}>
            {business.logoUrl ? <Image src={business.logoUrl} style={styles.logo} /> : null}
            <Text style={styles.brandName}>{business.name}</Text>
            <Text style={styles.brandMeta}>
              {(business.legalName && business.legalName !== business.name) ? business.legalName + "\n" : ""}
              {business.addressLines.join(" · ")}
            </Text>
          </View>
          <View style={styles.metaBlock}>
            <Text style={styles.kicker}>Receipt for</Text>
            <Text style={styles.docTitle}>{receipt.invoiceNumber}</Text>
            <View style={styles.metaRow}>
              <Text style={styles.metaRowLabel}>Paid on</Text>
              <Text>{paidOn}</Text>
            </View>
          </View>
        </View>

        <View style={styles.amountBlock}>
          <Text style={styles.amountLabel}>Amount paid</Text>
          <Text style={styles.amount}>{formatMoney(receipt.amount, receipt.currency)}</Text>
          <Text style={styles.paidOn}>{payment.methodLabel}</Text>
        </View>

        <View style={styles.twoCol}>
          <View style={styles.col}>
            <Text style={styles.blockLabel}>Paid by</Text>
            <Text style={{ fontSize: 12, fontWeight: 700, color: c.black, marginBottom: 2 }}>
              {paidBy.name}
            </Text>
            {paidBy.addressLines.map((line, i) => (
              <Text key={i} style={{ color: c.muted, lineHeight: 1.4 }}>
                {line}
              </Text>
            ))}
          </View>
          <View style={styles.col}>
            <Text style={styles.blockLabel}>For invoice</Text>
            <View style={styles.fieldRow}>
              <Text style={styles.fieldKey}>Number</Text>
              <Text style={styles.fieldVal}>{receipt.invoiceNumber}</Text>
            </View>
            <View style={styles.fieldRow}>
              <Text style={styles.fieldKey}>Issued</Text>
              <Text style={styles.fieldVal}>{invoice.issueDate}</Text>
            </View>
            <View style={styles.fieldRow}>
              <Text style={styles.fieldKey}>Invoice total</Text>
              <Text style={styles.fieldVal}>{formatMoney(invoice.total, invoice.currency)}</Text>
            </View>
          </View>
        </View>

        <View>
          <Text style={styles.blockLabel}>Transaction</Text>
          <View style={styles.fieldRow}>
            <Text style={styles.fieldKey}>Network</Text>
            <Text style={styles.fieldVal}>{payment.chainName}</Text>
          </View>
          {payment.payerAddress ? (
            <View style={styles.fieldRow}>
              <Text style={styles.fieldKey}>From</Text>
              <Text style={styles.txMono}>{payment.payerAddress}</Text>
            </View>
          ) : null}
          <View style={styles.fieldRow}>
            <Text style={styles.fieldKey}>Transaction hash</Text>
            {payment.txExplorerUrl ? (
              <Link src={payment.txExplorerUrl} style={styles.txLink}>
                {payment.txHash}
              </Link>
            ) : (
              <Text style={styles.txMono}>{payment.txHash}</Text>
            )}
          </View>
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerName}>{business.legalName ?? business.name}</Text>
          {business.taxId ? (
            <Text style={styles.footerMeta}>Tax ID: {business.taxId}</Text>
          ) : null}
          <Text style={styles.footerMeta}>
            {"This receipt confirms an on-chain payment recorded by enwise. The transaction hash above is the authoritative record on the blockchain."}
          </Text>
        </View>
      </Page>
    </Document>
  );
}
