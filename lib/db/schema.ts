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

export const businessPlan = pgEnum("business_plan", ["free", "pro"]);

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
  // Plan is account-level: one Pro subscription covers every business the
  // user owns. Makes pricing honest (a solo freelancer with Acme + a side
  // project shouldn't pay twice) and matches the one-token-one-account
  // auth model.
  plan: businessPlan("plan").notNull().default("free"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
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
// from each one independently. Plan is account-level (on users), not
// per-business. Pro unlocks Pro features across every business the
// user owns.

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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("businesses_owner_idx").on(t.ownerUserId)],
);

// API tokens. issued from web dashboard, presented as Authorization: Bearer <raw>

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("api_tokens_hash_idx").on(t.tokenHash),
    index("api_tokens_business_idx").on(t.businessId),
  ],
);

// Clients

export const clients = pgTable(
  "clients",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
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
    index("clients_business_idx").on(t.businessId),
    uniqueIndex("clients_business_email_idx")
      .on(t.businessId, sql`lower(${t.email})`)
      .where(sql`${t.email} is not null`),
  ],
);

// Products / services catalog

export const products = pgTable(
  "products",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
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
    index("products_business_idx").on(t.businessId),
    uniqueIndex("products_business_sku_idx")
      .on(t.businessId, t.sku)
      .where(sql`${t.sku} is not null`),
  ],
);

// Recurring invoice templates. must be declared before invoices, which FK-references it

export const recurringInvoiceTemplates = pgTable(
  "recurring_invoice_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
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
    index("recurring_business_idx").on(t.businessId),
    index("recurring_due_idx").on(t.nextRunAt, t.active),
  ],
);

// Invoices

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
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
    clientEmailSnapshot: text("client_email_snapshot"),
    clientAddressSnapshot: jsonb("client_address_snapshot"),
    businessNameSnapshot: text("business_name_snapshot"),
    businessAddressSnapshot: jsonb("business_address_snapshot"),
    businessLogoUrlSnapshot: text("business_logo_url_snapshot"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("invoices_business_number_idx").on(t.businessId, t.invoiceNumber),
    uniqueIndex("invoices_idempotency_idx")
      .on(t.businessId, t.clientRequestId)
      .where(sql`${t.clientRequestId} is not null`),
    index("invoices_business_status_date_idx").on(
      t.businessId,
      t.status,
      t.issueDate,
    ),
    index("invoices_business_client_date_idx").on(
      t.businessId,
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
