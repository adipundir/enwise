import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// Enums

export const invoiceStatus = pgEnum("invoice_status", [
  "draft",
  "sent",
  "paid",
  "void",
]);

export const recurringInterval = pgEnum("recurring_interval", [
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "yearly",
]);

// Auth.js tables. shape dictated by @auth/drizzle-adapter

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name"),
  email: text("email").notNull().unique(),
  emailVerified: timestamp("email_verified", {
    mode: "date",
    withTimezone: true,
  }),
  image: text("image"),
  defaultBusinessId: uuid("default_business_id").references(
    (): AnyPgColumn => businesses.id,
    { onDelete: "set null" },
  ),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const accounts = pgTable(
  "accounts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date", withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

// Businesses. the tenant unit. A user can own many. they bill clients
// from each one independently.

export const businesses = pgTable(
  "businesses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    legalName: text("legal_name"),
    taxId: text("tax_id"),
    // Optional human contact at the business — counterpart to clients.contactName.
    // Surfaced in the email footer / PDF letterhead when present.
    contactName: text("contact_name"),
    // Onchain payment address. Free-form string so users can enter a raw
    // 0x… address, an ENS name, or a multi-chain identifier. No format
    // enforcement — UI just renders what's there.
    walletAddress: text("wallet_address"),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    region: text("region"),
    postalCode: text("postal_code"),
    country: char("country", { length: 2 }),
    defaultCurrency: char("default_currency", { length: 3 })
      .notNull()
      .default("USD"),
    invoiceNumberPrefix: text("invoice_number_prefix")
      .notNull()
      .default("INV-"),
    invoiceNumberNext: integer("invoice_number_next").notNull().default(1),
    logoUrl: text("logo_url"),
    brandColor: text("brand_color"),
    emailReplyTo: text("email_reply_to"),
    defaultPaymentTermsDays: integer("default_payment_terms_days").default(30),
    defaultNotes: text("default_notes"),
    // Bank payout details now live in business_bank_accounts (one row per
    // account, with an is_default flag). Use add_bank_account / set_default_bank_account
    // MCP tools to manage them.
    // Preferred EVM chain id for receiving USDC wallet payments. NULL = use
    // platform default (NEXT_PUBLIC_DEFAULT_CHAIN_ID, currently Base mainnet).
    // Supported values are enumerated in lib/web3/chain.ts.
    paymentChainId: integer("payment_chain_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("businesses_owner_idx").on(t.ownerUserId)],
);

// API tokens. issued from web dashboard, presented as Authorization: Bearer <raw>.
// User-scoped: `resolveBearer` returns the `userId` and the per-call business
// is resolved from the tool's `business_id` arg or the user's default business.

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    /** AES-256-GCM ciphertext as base64(nonce || ct || authTag). Decrypted
     *  with TOKEN_ENC_KEY env var (NOT in the DB) so the dashboard can show
     *  the user their key on revisit without forcing a rotate. Nullable for
     *  back-compat with rows created before encrypt-at-rest was enabled —
     *  those still authenticate via tokenHash, just can't be displayed. */
    tokenEncrypted: text("token_encrypted"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("api_tokens_hash_idx").on(t.tokenHash)],
);

// Bank payout accounts. A business can have multiple — e.g. a USD account
// for international wires, an INR account for domestic, a EUR IBAN for
// Europe-based clients. The is_default flag (enforced unique-per-business
// via a partial index) controls which one new invoices auto-select.
//
// Soft-delete via deleted_at so existing invoices that snapshot one of
// these accounts still have a recoverable lineage.

export const businessBankAccounts = pgTable(
  "business_bank_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    /** Short human label the merchant uses to disambiguate accounts in MCP
     *  prompts and on the rendered invoice. e.g. "USD primary", "INR HDFC". */
    label: text("label").notNull(),
    accountHolder: text("account_holder"),
    bankName: text("bank_name"),
    accountNumber: text("account_number"),
    ifsc: text("ifsc"),
    swift: text("swift"),
    iban: text("iban"),
    branchAddress: text("branch_address"),
    /** Optional ISO 4217 hint — informational only, not enforced against
     *  invoice currency. Helps the merchant remember which account is for
     *  which rail. */
    currency: char("currency", { length: 3 }),
    isDefault: boolean("is_default").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("business_bank_accounts_business_idx").on(t.businessId),
    // At most one default per business. Partial index excludes both the
    // !default rows and the soft-deleted rows, so a deleted default doesn't
    // block setting a new one.
    uniqueIndex("business_bank_accounts_one_default_idx")
      .on(t.businessId)
      .where(sql`${t.isDefault} = true AND ${t.deletedAt} IS NULL`),
  ],
);

// Clients. Owned by the user (account-level, shared across all the user's
// businesses). Reads scope by ownerUserId.

export const clients = pgTable(
  "clients",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Optional human contact at the client. If set, used as the email
    // greeting ("Hi Aditya,") instead of the entity name.
    contactName: text("contact_name"),
    // Onchain identity / payout address for the client. Free-form string
    // (raw 0x… address or ENS name); no format enforcement.
    walletAddress: text("wallet_address"),
    // Normalized for fuzzy search. immutable_unaccent is defined by lib/db/migrate.ts
    // because the stock unaccent() is STABLE and can't be used in a generated column.
    nameNormalized: text("name_normalized").generatedAlwaysAs(
      sql`lower(immutable_unaccent(name))`,
    ),
    email: text("email"),
    phone: text("phone"),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    region: text("region"),
    postalCode: text("postal_code"),
    country: char("country", { length: 2 }),
    taxId: text("tax_id"),
    notes: text("notes"),
    defaultCurrency: char("default_currency", { length: 3 }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("clients_owner_idx").on(t.ownerUserId),
    uniqueIndex("clients_owner_email_idx")
      .on(t.ownerUserId, sql`lower(${t.email})`)
      .where(sql`${t.email} is not null`),
  ],
);

// Products / services catalog. Owned by the user (account-level), reusable
// across every business they own.

export const products = pgTable(
  "products",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    nameNormalized: text("name_normalized").generatedAlwaysAs(
      sql`lower(immutable_unaccent(name))`,
    ),
    description: text("description"),
    unitPrice: numeric("unit_price", { precision: 14, scale: 2 }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    defaultTaxRate: numeric("default_tax_rate", { precision: 6, scale: 4 }),
    sku: text("sku"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("products_owner_idx").on(t.ownerUserId),
    uniqueIndex("products_owner_sku_idx")
      .on(t.ownerUserId, t.sku)
      .where(sql`${t.sku} is not null`),
  ],
);

// Recurring invoice templates. Owned by the user; businessId is the
// "render under this business" pointer for generated invoices, mutable.

export const recurringInvoiceTemplates = pgTable(
  "recurring_invoice_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "restrict" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    name: text("name"),
    lineItems: jsonb("line_items").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    notes: text("notes"),
    terms: text("terms"),
    paymentTermsDays: integer("payment_terms_days"),
    interval: recurringInterval("interval").notNull(),
    anchorDay: integer("anchor_day"),
    nextRunAt: date("next_run_at").notNull(),
    lastRunAt: date("last_run_at"),
    active: boolean("active").notNull().default(true),
    autoSend: boolean("auto_send").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("recurring_owner_idx").on(t.ownerUserId),
    index("recurring_business_idx").on(t.businessId),
    index("recurring_due_idx").on(t.nextRunAt, t.active),
  ],
);

// Invoices. Owned by the user; businessId is the "render under this
// business" pointer (which letterhead, address, logo, numbering scheme).
// Mutable on drafts, frozen on sent/paid via snapshots below.

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    invoiceNumber: text("invoice_number").notNull(),
    status: invoiceStatus("status").notNull().default("draft"),
    issueDate: date("issue_date").notNull(),
    dueDate: date("due_date").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    subtotal: numeric("subtotal", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    taxTotal: numeric("tax_total", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    total: numeric("total", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    amountPaid: numeric("amount_paid", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    notes: text("notes"),
    terms: text("terms"),
    shareSlug: text("share_slug").notNull().unique(),
    shareEnabled: boolean("share_enabled").notNull().default(true),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    viewedAt: timestamp("viewed_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    clientRequestId: text("client_request_id"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    recurringTemplateId: uuid("recurring_template_id").references(
      () => recurringInvoiceTemplates.id,
      { onDelete: "set null" },
    ),
    // Snapshots. captured at finalize so later edits to client/business don't mutate sent invoices
    clientNameSnapshot: text("client_name_snapshot"),
    clientContactNameSnapshot: text("client_contact_name_snapshot"),
    clientEmailSnapshot: text("client_email_snapshot"),
    clientWalletAddressSnapshot: text("client_wallet_address_snapshot"),
    clientAddressSnapshot: jsonb("client_address_snapshot"),
    businessNameSnapshot: text("business_name_snapshot"),
    businessLegalNameSnapshot: text("business_legal_name_snapshot"),
    businessTaxIdSnapshot: text("business_tax_id_snapshot"),
    businessContactNameSnapshot: text("business_contact_name_snapshot"),
    businessWalletAddressSnapshot: text("business_wallet_address_snapshot"),
    businessAddressSnapshot: jsonb("business_address_snapshot"),
    businessLogoUrlSnapshot: text("business_logo_url_snapshot"),
    /** Frozen at finalize: an array of {id?, label, account_holder, bank_name,
     *  account_number, ifsc, swift, iban, branch_address, currency} objects
     *  representing the bank accounts to surface on this specific invoice.
     *  Renderers prefer this over live business_bank_accounts when present. */
    businessBankAccountsSnapshot: jsonb("business_bank_accounts_snapshot"),
    // Per-invoice atomic overrides for displayed business / client fields.
    // Partial JSON; key presence = override (including null = explicit hide),
    // missing key = fall through to snapshot / live value. See
    // lib/invoices/displayResolver.ts for shape + resolution order.
    displayOverrides: jsonb("display_overrides"),
    // Per-invoice payment method gate. NULL = show everything configured
    // (current behavior). Non-null = only show methods listed here. Values:
    // 'bank', 'crypto_wallet'.
    acceptedPaymentMethods: text("accepted_payment_methods").array(),
    /** Per-invoice picker for which bank accounts to surface. NULL = use
     *  the merchant's default account (or all accounts if no default).
     *  [] = explicitly hide the bank panel even if accepted_payment_methods
     *  permits it. Otherwise: render exactly these accounts in order. */
    acceptedBankAccountIds: uuid("accepted_bank_account_ids").array(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("invoices_owner_idx").on(t.ownerUserId),
    uniqueIndex("invoices_business_number_idx").on(t.businessId, t.invoiceNumber),
    uniqueIndex("invoices_idempotency_idx")
      .on(t.ownerUserId, t.clientRequestId)
      .where(sql`${t.clientRequestId} is not null`),
    index("invoices_owner_status_date_idx").on(
      t.ownerUserId,
      t.status,
      t.issueDate,
    ),
    index("invoices_owner_client_date_idx").on(
      t.ownerUserId,
      t.clientId,
      t.issueDate,
    ),
  ],
);

export const invoiceLineItems = pgTable(
  "invoice_line_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 14, scale: 2 }).notNull(),
    taxRate: numeric("tax_rate", { precision: 6, scale: 4 })
      .notNull()
      .default("0"),
    // Per-item context: conversion math, reference IDs, dates, source invoice
    // numbers. Whole-invoice context lives on invoices.notes instead.
    note: text("note"),
    lineSubtotal: numeric("line_subtotal", {
      precision: 14,
      scale: 2,
    }).notNull(),
    lineTax: numeric("line_tax", { precision: 14, scale: 2 }).notNull(),
    lineTotal: numeric("line_total", { precision: 14, scale: 2 }).notNull(),
    // Supporting docs: receipts, photo proofs, spec links etc. Rendered as
    // clickable links on the public invoice page and in the PDF.
    attachments: jsonb("attachments")
      .$type<Array<{ label: string; url: string }>>()
      .notNull()
      .default([]),
  },
  (t) => [index("line_items_invoice_idx").on(t.invoiceId)],
);

// Append-only audit trail for invoice lifecycle events

export const invoiceEvents = pgTable(
  "invoice_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    actor: text("actor"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("invoice_events_invoice_idx").on(t.invoiceId)],
);

// Onchain payments against an invoice. One row per confirmed payment; an
// invoice can have multiple if partial payments come in. Records direct
// ERC-20 transfers from a payer's wallet to the merchant's wallet address.

export const invoicePayments = pgTable(
  "invoice_payments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    chainId: integer("chain_id").notNull(),
    txHash: text("tx_hash").notNull(),
    // "private_unshield" | "direct_transfer" | "manual"
    paymentMethod: text("payment_method").notNull(),
    payerAddress: text("payer_address"),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("invoice_payments_tx_idx").on(t.chainId, t.txHash),
    index("invoice_payments_invoice_idx").on(t.invoiceId),
  ],
);

// Idempotency cache for one-shot operations (send_invoice, etc.)

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    clientRequestId: text("client_request_id").notNull(),
    responseJson: jsonb("response_json"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("idempotency_lookup_idx").on(
      t.businessId,
      t.toolName,
      t.clientRequestId,
    ),
    index("idempotency_expiry_idx").on(t.expiresAt),
  ],
);

// Type exports. consumers should import inferred types from here

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Business = typeof businesses.$inferSelect;
export type NewBusiness = typeof businesses.$inferInsert;
export type ApiToken = typeof apiTokens.$inferSelect;
export type NewApiToken = typeof apiTokens.$inferInsert;
export type BusinessBankAccount = typeof businessBankAccounts.$inferSelect;
export type NewBusinessBankAccount = typeof businessBankAccounts.$inferInsert;
export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
export type InvoiceLineItem = typeof invoiceLineItems.$inferSelect;
export type NewInvoiceLineItem = typeof invoiceLineItems.$inferInsert;
export type RecurringInvoiceTemplate =
  typeof recurringInvoiceTemplates.$inferSelect;
export type NewRecurringInvoiceTemplate =
  typeof recurringInvoiceTemplates.$inferInsert;
export type InvoiceEvent = typeof invoiceEvents.$inferSelect;
export type NewInvoiceEvent = typeof invoiceEvents.$inferInsert;
export type InvoicePayment = typeof invoicePayments.$inferSelect;
export type NewInvoicePayment = typeof invoicePayments.$inferInsert;
