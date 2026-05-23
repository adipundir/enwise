import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";

export interface InvoiceVoidedEmailProps {
  invoiceNumber: string;
  clientName: string;
  contactName: string | null;
  businessName: string;
  shareUrl: string;
  reason: string | null;
}

/**
 * Sent to the email the invoice was originally delivered to when the
 * merchant voids it. Tone: factual, brief, no marketing copy. Recipient
 * just needs to know "the document I have is no longer valid; don't pay it".
 */
export function InvoiceVoidedEmail({
  invoiceNumber,
  clientName,
  contactName,
  businessName,
  shareUrl,
  reason,
}: InvoiceVoidedEmailProps) {
  const greetingTarget = contactName || clientName;
  const previewText = `${businessName} voided invoice ${invoiceNumber}`;
  return (
    <Html>
      <Head>
        <meta name="color-scheme" content="light only" />
        <meta name="supported-color-schemes" content="light" />
      </Head>
      <Preview>{previewText}</Preview>
      <Body
        style={{
          backgroundColor: "#f4f4f5",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          margin: 0,
          padding: "24px 0",
        }}
      >
        <Container
          style={{
            backgroundColor: "#ffffff",
            borderRadius: 16,
            maxWidth: 560,
            padding: "32px 32px 28px",
            boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
          }}
        >
          <Section>
            <Text
              style={{
                fontSize: 10,
                letterSpacing: 2,
                textTransform: "uppercase",
                color: "#dc2626",
                margin: 0,
              }}
            >
              Invoice voided
            </Text>
            <Text
              style={{
                fontSize: 20,
                color: "#18181b",
                margin: "8px 0 0",
                fontWeight: 600,
              }}
            >
              {invoiceNumber}
            </Text>
          </Section>
          <Hr style={{ borderColor: "#e4e4e7", margin: "24px 0" }} />
          <Section>
            <Text style={{ color: "#18181b", margin: 0, lineHeight: 1.6 }}>
              Hi {greetingTarget},
            </Text>
            <Text
              style={{
                color: "#3f3f46",
                margin: "12px 0 0",
                lineHeight: 1.6,
              }}
            >
              {businessName} has voided invoice {invoiceNumber}. No payment is
              due on this invoice. If you have already paid, please reach out
              to {businessName} directly to confirm next steps (refund,
              re-issue, or applying the payment elsewhere).
            </Text>
            {reason ? (
              <Text
                style={{
                  color: "#3f3f46",
                  margin: "12px 0 0",
                  lineHeight: 1.6,
                }}
              >
                Reason provided by the issuer: {reason}
              </Text>
            ) : null}
            <Text
              style={{
                color: "#71717a",
                margin: "20px 0 0",
                lineHeight: 1.6,
                fontSize: 13,
              }}
            >
              You can still view the (now-voided) invoice here:{" "}
              <a href={shareUrl} style={{ color: "#52525b" }}>
                {shareUrl}
              </a>
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
