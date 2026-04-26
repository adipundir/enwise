import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

/**
 * Canonical error codes our MCP tools return via `structuredContent.error.code`.
 * Claude reads these + the accompanying `hint` to self-correct.
 */
export type ErrorCode =
  | "invalid_input"
  | "not_found"
  | "ambiguous_client"
  | "ambiguous_product"
  | "invoice_finalized"
  | "invoice_not_draft"
  | "invalid_transition"
  | "logo_too_large"
  | "logo_invalid_mime"
  | "logo_fetch_failed"
  | "logo_storage_unavailable"
  | "duplicate_invoice_number"
  | "onboarding_required"
  | "attachment_too_large"
  | "attachment_invalid_mime"
  | "attachment_storage_unavailable"
  | "multiple_businesses"
  | "no_businesses"
  | "business_not_found"
  | "business_limit_reached"
  | "internal_error";

export interface ToolErrorBody {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    hint?: string;
    suggestions?: unknown;
  };
}

export interface ToolOkBody<T> {
  ok: true;
  data: T;
}

export type ToolBody<T> = ToolOkBody<T> | ToolErrorBody;

export function toolOk<T>(data: T): CallToolResult {
  const body: ToolOkBody<T> = { ok: true, data };
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    structuredContent: body as unknown as { [k: string]: unknown },
  };
}

export function toolError(
  code: ErrorCode,
  message: string,
  opts: { hint?: string; suggestions?: unknown } = {},
): CallToolResult {
  const body: ToolErrorBody = {
    ok: false,
    error: { code, message, hint: opts.hint, suggestions: opts.suggestions },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    structuredContent: body as unknown as { [k: string]: unknown },
    isError: true,
  };
}

/**
 * Convert a Zod parse failure to a tool error Claude can read. Surfaces the
 * first failing path so the hint is actionable instead of a wall of JSON.
 */
export function zodToToolError(err: z.ZodError): CallToolResult {
  const first = err.issues[0];
  const path = first?.path.join(".") || "(input)";
  return toolError("invalid_input", `Invalid input at ${path}: ${first?.message ?? "failed validation"}`, {
    hint: "Re-send the tool call with the corrected field. See `suggestions` for the full validation error list.",
    suggestions: err.issues.map((i) => ({
      path: i.path.join("."),
      code: i.code,
      message: i.message,
    })),
  });
}
