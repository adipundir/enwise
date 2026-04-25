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
  businessName: string;
  logoUrl: string | null;
  total: string;
  currency: string;
  dueDate: string;
  shareUrl: string;
  customMessage: string | null;
  businessAddressLines: string[];
}

export function InvoiceEmail({
  invoiceNumber,
  clientName,
  businessName,
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
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Section style={styles.header}>
            {logoUrl ? (
              <Img
                src={logoUrl}
                alt={businessName}
                width="64"
                style={styles.logo}
              />
            ) : null}
            <Text style={styles.brand}>{businessName}</Text>
          </Section>

          <Text style={styles.greeting}>Hi {clientName},</Text>

          <Text style={styles.body1}>
            {businessName} sent you invoice{" "}
            <strong>{invoiceNumber}</strong> for{" "}
            <strong>{formattedTotal}</strong>, due <strong>{dueDate}</strong>.
          </Text>

          {customMessage ? (
            <Section style={styles.note}>
              <Text style={styles.noteText}>{customMessage}</Text>
            </Section>
          ) : null}

          <Section style={{ textAlign: "center", margin: "32px 0" }}>
            <Button href={shareUrl} style={styles.button}>
              View invoice
            </Button>
          </Section>

          <Text style={styles.muted}>
            A PDF copy is attached. If the button doesn't work, open the
            invoice directly:{" "}
            <a href={shareUrl} style={styles.link}>
              {shareUrl}
            </a>
          </Text>

          <Hr style={styles.hr} />

          <Section style={styles.footer}>
            <Text style={styles.footerText}>
              <strong>{businessName}</strong>
              {businessAddressLines.length > 0 ? (
                <>
                  <br />
                  {businessAddressLines.join(" · ")}
                </>
              ) : null}
            </Text>
            <Text style={styles.footerText}>Powered by envoice</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

const styles = {
  body: {
    backgroundColor: "#f4f4f5",
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    color: "#18181b",
    margin: 0,
    padding: "24px 0",
  },
  container: {
    maxWidth: "560px",
    margin: "0 auto",
    backgroundColor: "#ffffff",
    padding: "40px",
    borderRadius: "12px",
  },
  header: {
    marginBottom: "24px",
  },
  logo: {
    marginBottom: "12px",
    objectFit: "contain" as const,
  },
  brand: {
    fontSize: "18px",
    fontWeight: 600,
    margin: 0,
  },
  greeting: {
    fontSize: "16px",
    marginBottom: "12px",
  },
  body1: {
    fontSize: "15px",
    lineHeight: 1.5,
    color: "#27272a",
  },
  note: {
    borderLeft: "3px solid #e4e4e7",
    padding: "4px 16px",
    margin: "20px 0",
  },
  noteText: {
    fontSize: "14px",
    color: "#3f3f46",
    margin: 0,
    whiteSpace: "pre-wrap" as const,
  },
  button: {
    backgroundColor: "#0a0a0a",
    color: "#fafafa",
    padding: "12px 24px",
    borderRadius: "8px",
    fontSize: "14px",
    fontWeight: 500,
    textDecoration: "none",
    display: "inline-block",
  },
  muted: {
    fontSize: "13px",
    color: "#71717a",
    lineHeight: 1.5,
    wordBreak: "break-all" as const,
  },
  link: {
    color: "#3f3f46",
    textDecoration: "underline",
  },
  hr: {
    borderColor: "#e4e4e7",
    margin: "32px 0",
  },
  footer: {
    marginTop: "12px",
  },
  footerText: {
    fontSize: "12px",
    color: "#71717a",
    lineHeight: 1.5,
    margin: "6px 0",
  },
};
