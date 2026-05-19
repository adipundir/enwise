import {
  Body,
  Button,
  Container,
  Head,
  Hr,
  Html,
  Img,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import { formatMoney } from "@/lib/money";

export interface PaymentReceivedEmailProps {
  invoiceNumber: string;
  /** Who this copy is addressed to. Drives subject + greeting + lead copy. */
  recipientRole: "merchant" | "client";
  businessName: string;
  businessLegalName: string | null;
  logoUrl: string | null;
  /** Display name to greet in the body. For merchant: business contact name
   *  or business name. For client: client contact name or client name. */
  greetingName: string;
  /** Counterparty referenced in the lead sentence. For merchant copy this
   *  is the client name; for client copy this is the business name. */
  counterpartyName: string;
  amount: string;
  currency: string;
  txHash: string;
  /** Pre-built block-explorer URL for the tx. */
  txExplorerUrl: string;
  /** Hosted invoice page URL — same one used on the original invoice email. */
  shareUrl: string;
  businessAddressLines: string[];
}

export function PaymentReceivedEmail({
  invoiceNumber,
  recipientRole,
  businessName,
  businessLegalName,
  logoUrl,
  greetingName,
  counterpartyName,
  amount,
  currency,
  txHash,
  txExplorerUrl,
  shareUrl,
  businessAddressLines,
}: PaymentReceivedEmailProps) {
  const formattedAmount = formatMoney(amount, currency);
  const isMerchant = recipientRole === "merchant";

  const previewText = isMerchant
    ? `${counterpartyName} paid ${formattedAmount} for ${invoiceNumber}`
    : `Payment of ${formattedAmount} for ${invoiceNumber} confirmed`;

  const lead = isMerchant
    ? `${counterpartyName} just paid ${formattedAmount} for invoice ${invoiceNumber}. The transaction has confirmed on-chain and the invoice is now marked paid.`
    : `Your payment of ${formattedAmount} for invoice ${invoiceNumber} has confirmed on-chain. ${counterpartyName} has been notified and the invoice is marked paid. Keep this as your receipt.`;

  const txShort = `${txHash.slice(0, 10)}…${txHash.slice(-8)}`;

  return (
    <Html>
      <Head>
        <meta name="color-scheme" content="light only" />
        <meta name="supported-color-schemes" content="light" />
      </Head>
      <Preview>{previewText}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Section style={styles.letterhead}>
            {logoUrl ? (
              <Img
                src={logoUrl}
                alt={businessName}
                width="56"
                style={styles.logo}
              />
            ) : null}
            <Text style={styles.brand}>{businessName}</Text>
          </Section>

          <Hr style={styles.ruleTop} />

          <Section style={styles.metaBlock}>
            <Text style={styles.kicker}>
              {isMerchant ? "Payment received" : "Payment confirmed"}
            </Text>
            <Text style={styles.amount}>{formattedAmount}</Text>
            <Text style={styles.muted}>Invoice {invoiceNumber}</Text>
          </Section>

          <Hr style={styles.rule} />

          <Section>
            <Text style={styles.greeting}>Hi {greetingName},</Text>
            <Text style={styles.body1}>{lead}</Text>
          </Section>

          <Section style={styles.txBlock}>
            <Text style={styles.kicker}>Transaction</Text>
            <Text style={styles.txHash}>
              <a href={txExplorerUrl} style={styles.link}>
                {txShort}
              </a>
            </Text>
          </Section>

          <Section style={styles.ctaBlock}>
            <Button href={shareUrl} style={styles.button}>
              View invoice
            </Button>
          </Section>

          <Hr style={styles.rule} />

          <Section style={styles.footer}>
            <Text style={styles.footerBrand}>{businessLegalName ?? businessName}</Text>
            {businessAddressLines.length > 0 ? (
              <Text style={styles.footerText}>
                {businessAddressLines.join(" · ")}
              </Text>
            ) : null}
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

const c = {
  pageBg: "#f4f4f5",
  cardBg: "#ffffff",
  ink: "#18181b",
  text: "#27272a",
  muted: "#71717a",
  line: "#e4e4e7",
  black: "#0a0a0a",
};

const systemSans =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const systemMono =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

const styles = {
  body: {
    backgroundColor: c.pageBg,
    fontFamily: systemSans,
    color: c.text,
    margin: 0,
    padding: "32px 16px",
    colorScheme: "light only",
  },
  container: {
    maxWidth: "600px",
    margin: "0 auto",
    backgroundColor: c.cardBg,
    padding: "40px",
    borderRadius: "16px",
    border: `1px solid ${c.line}`,
  },
  letterhead: { marginBottom: "20px" },
  logo: { marginBottom: "10px", objectFit: "contain" as const },
  brand: {
    fontSize: "18px",
    fontWeight: 600,
    color: c.ink,
    margin: 0,
    letterSpacing: "-0.01em",
  },
  ruleTop: { borderColor: c.line, margin: "4px 0 20px" },
  metaBlock: { marginBottom: "8px" },
  kicker: {
    fontSize: "10px",
    letterSpacing: "0.12em",
    textTransform: "uppercase" as const,
    color: c.muted,
    margin: "0 0 6px",
  },
  amount: {
    fontSize: "28px",
    fontFamily: systemMono,
    fontWeight: 600,
    color: c.ink,
    margin: "0 0 4px",
    letterSpacing: "-0.02em",
  },
  muted: {
    fontSize: "13px",
    color: c.muted,
    margin: 0,
  },
  rule: { borderColor: c.line, margin: "20px 0" },
  greeting: {
    fontSize: "15px",
    color: c.text,
    margin: "0 0 8px",
  },
  body1: {
    fontSize: "14px",
    lineHeight: 1.55,
    color: c.text,
    margin: "0 0 8px",
  },
  txBlock: { margin: "16px 0 4px" },
  txHash: {
    fontSize: "13px",
    fontFamily: systemMono,
    color: c.ink,
    margin: 0,
    wordBreak: "break-all" as const,
  },
  link: { color: c.ink, textDecoration: "underline" },
  ctaBlock: { textAlign: "left" as const, margin: "20px 0 8px" },
  button: {
    backgroundColor: c.black,
    color: "#ffffff",
    padding: "10px 18px",
    borderRadius: "8px",
    fontWeight: 500,
    fontSize: "14px",
    textDecoration: "none",
    display: "inline-block",
  },
  footer: { marginTop: "8px" },
  footerBrand: {
    fontSize: "13px",
    fontWeight: 600,
    color: c.ink,
    margin: "0 0 2px",
  },
  footerText: {
    fontSize: "12px",
    color: c.muted,
    margin: 0,
  },
};
