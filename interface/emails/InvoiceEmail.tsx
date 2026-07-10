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

export interface InvoiceEmailProps {
  invoiceNumber: string;
  clientName: string;
  contactName: string | null;
  businessName: string;
  businessLegalName: string | null;
  logoUrl: string | null;
  total: string;
  currency: string;
  dueDate: string | null;
  shareUrl: string;
  customMessage: string | null;
  businessAddressLines: string[];
}

/**
 * Invoice notification email. Designed to mirror the public /i/[slug]
 * page's aesthetic: white card on a zinc-100 page, uppercase kicker
 * labels, mono font for the invoice number, generous vertical rhythm.
 *
 * We intentionally opt out of email-client dark-mode inversion via the
 * color-scheme meta + supported-color-schemes meta. Modern Apple Mail,
 * Outlook, and iOS Mail honor this.
 */
export function InvoiceEmail({
  invoiceNumber,
  clientName,
  contactName,
  businessName,
  businessLegalName,
  logoUrl,
  total,
  currency,
  dueDate,
  shareUrl,
  customMessage,
  businessAddressLines,
}: InvoiceEmailProps) {
  const formattedTotal = formatMoney(total, currency);
  const previewText = `${businessName} sent you invoice ${invoiceNumber} for ${formattedTotal}`;

  return (
    <Html>
      <Head>
        <meta name="color-scheme" content="light only" />
        <meta name="supported-color-schemes" content="light" />
      </Head>
      <Preview>{previewText}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          {/* Letterhead: logo + business */}
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

          {/* Invoice meta block. mirrors the right column of /i/[slug] */}
          <Section style={styles.metaBlock}>
            <table
              cellPadding={0}
              cellSpacing={0}
              width="100%"
              style={styles.metaTable}
            >
              <tbody>
                <tr>
                  <td style={styles.metaLabelCell}>Invoice</td>
                  <td style={styles.metaValueCellStrong}>{invoiceNumber}</td>
                </tr>
                <tr>
                  <td style={styles.metaLabelCell}>Total</td>
                  <td style={styles.metaValueCell}>{formattedTotal}</td>
                </tr>
                {dueDate ? (
                  <tr>
                    <td style={styles.metaLabelCell}>Due date</td>
                    <td style={styles.metaValueCell}>{dueDate}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </Section>

          <Hr style={styles.rule} />

          {/* Body copy */}
          <Section>
            <Text style={styles.greeting}>Hi {contactName ?? clientName},</Text>
            <Text style={styles.body1}>
              The PDF is attached. Full details, including payment
              instructions, are linked below.
            </Text>

            {customMessage ? (
              <Section style={styles.note}>
                <Text style={styles.kicker}>Message</Text>
                <Text style={styles.noteText}>{customMessage}</Text>
              </Section>
            ) : null}
          </Section>

          {/* CTA */}
          <Section style={styles.ctaBlock}>
            <Button href={shareUrl} style={styles.button}>
              View invoice
            </Button>
          </Section>

          <Text style={styles.muted}>
            Or open it directly at{" "}
            <a href={shareUrl} style={styles.link}>
              {shareUrl}
            </a>
            .
          </Text>

          <Hr style={styles.rule} />

          {/* Footer letterhead echo */}
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

// Palette pinned to the same zinc scale the /i/[slug] page uses.
const c = {
  pageBg: "#f4f4f5", // zinc-100
  cardBg: "#ffffff",
  ink: "#18181b", // zinc-900
  text: "#27272a", // zinc-800
  muted: "#71717a", // zinc-500
  soft: "#a1a1aa", // zinc-400
  line: "#e4e4e7", // zinc-200
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
  letterhead: {
    marginBottom: "20px",
  },
  logo: {
    marginBottom: "10px",
    objectFit: "contain" as const,
  },
  brand: {
    fontSize: "18px",
    fontWeight: 600,
    color: c.ink,
    margin: 0,
    letterSpacing: "-0.01em",
  },
  ruleTop: {
    borderColor: c.line,
    margin: "4px 0 20px",
  },
  metaBlock: {
    marginBottom: "8px",
  },
  metaTable: {
    borderCollapse: "collapse" as const,
  },
  metaLabelCell: {
    fontSize: "10px",
    letterSpacing: "0.12em",
    textTransform: "uppercase" as const,
    color: c.muted,
    padding: "4px 0",
    width: "110px",
  },
  metaValueCell: {
    fontSize: "14px",
    color: c.ink,
    padding: "4px 0",
  },
  metaValueCellStrong: {
    fontSize: "14px",
    color: c.ink,
    padding: "4px 0",
    fontFamily: systemMono,
    fontWeight: 600,
    letterSpacing: "-0.01em",
  },
  rule: {
    borderColor: c.line,
    margin: "20px 0",
  },
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
  kicker: {
    fontSize: "10px",
    letterSpacing: "0.12em",
    textTransform: "uppercase" as const,
    color: c.muted,
    margin: "0 0 6px",
  },
  note: {
    borderLeft: `3px solid ${c.line}`,
    padding: "4px 14px",
    margin: "16px 0",
  },
  noteText: {
    fontSize: "14px",
    color: c.text,
    lineHeight: 1.55,
    margin: 0,
    whiteSpace: "pre-wrap" as const,
  },
  ctaBlock: {
    textAlign: "center" as const,
    margin: "28px 0 16px",
  },
  button: {
    backgroundColor: c.black,
    color: "#fafafa",
    padding: "12px 28px",
    borderRadius: "8px",
    fontSize: "14px",
    fontWeight: 500,
    textDecoration: "none",
    display: "inline-block",
  },
  muted: {
    fontSize: "12px",
    color: c.muted,
    lineHeight: 1.55,
    wordBreak: "break-all" as const,
    margin: 0,
  },
  link: {
    color: c.text,
    textDecoration: "underline",
  },
  footer: {
    marginTop: "8px",
  },
  footerBrand: {
    fontSize: "13px",
    fontWeight: 600,
    color: c.ink,
    margin: "0 0 4px",
  },
  footerText: {
    fontSize: "12px",
    color: c.muted,
    lineHeight: 1.5,
    margin: "0 0 12px",
  },
  footerMuted: {
    fontSize: "11px",
    color: c.soft,
    margin: 0,
  },
};
