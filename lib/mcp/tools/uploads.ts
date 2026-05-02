import { z } from "zod";
import { ctxFromAuthInfo } from "@/lib/mcp/context";
import { toolError, toolOk, zodToToolError } from "@/lib/mcp/errors";
import {
  ATTACHMENT_MAX_BYTES,
  presignAttachmentUpload,
} from "@/lib/uploads/presign";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Canonical upload entry point for MCP / Claude callers.
 *
 * Returns a presigned PUT URL the caller uses to send bytes directly to
 * Vercel Blob. The MCP bearer token is consumed when the server validates
 * the tool call, so the caller never needs to know it; the returned PUT
 * URL carries its own scoped, short-lived credential signed by the server.
 *
 * Why a tool and not a curl-the-/api/upload-endpoint instruction:
 *   - The MCP bearer token lives in Claude Code's MCP client config and
 *     is never surfaced to the model. Asking the model to curl the HTTP
 *     endpoint with `Authorization: Bearer …` is asking for a value it
 *     cannot read. This tool collapses that round trip.
 */

const inputShape = {
  /**
   * Original filename. Stored on the attachment record as the human label;
   * the actual storage path is randomized for collision safety.
   */
  filename: z.string().min(1).max(256),
  /**
   * MIME type of the file you're about to upload. Must be one of the four
   * allowed types — anything else is rejected before a token is minted so
   * Claude doesn't waste a roundtrip.
   */
  mime_type: z.enum([
    "image/png",
    "image/jpeg",
    "image/webp",
    "application/pdf",
  ]),
};

export function registerUploadTools(server: McpServer) {
  server.registerTool(
    "request_attachment_upload",
    {
      title: "Get a presigned URL to upload an invoice attachment",
      description:
        "Mint a short-lived (30 min) presigned PUT URL for ONE attachment, then PUT the file bytes directly to Vercel Blob. Use this for every receipt, invoice scan, and screenshot you attach to a line item. Files up to 10 MB. Allowed types: PNG, JPEG, WebP, PDF.\n\n" +
        "## Flow (always exactly two steps)\n\n" +
        "1. Call `request_attachment_upload({filename, mime_type})`. You get back `{method:'PUT', url, headers, ...}`.\n" +
        "2. Run ONE shell command to PUT the bytes:\n" +
        "   ```\n" +
        '   curl -sS -X PUT "<url>" \\\n' +
        '     -H "authorization: <headers.authorization>" \\\n' +
        '     -H "x-api-version: 12" \\\n' +
        '     -H "x-content-type: <headers.x-content-type>" \\\n' +
        '     -H "x-vercel-blob-access: public" \\\n' +
        "     --data-binary @/absolute/path/to/file.pdf\n" +
        "   ```\n" +
        "   The PUT response body is JSON with a `url` field. That public `url` is what you pass as `attachment_url` when creating or updating an invoice line item.\n\n" +
        "## Rules\n\n" +
        "- ONE file per tool call. Don't try to batch.\n" +
        "- NEVER base64-encode the file and inline it as a tool argument. Bytes go through curl, not through MCP.\n" +
        "- NEVER chunk or split a file. The 10 MB cap is hard; if a file exceeds it, ask the user to compress or split the source document.\n" +
        "- The PUT URL expires in 30 minutes. If you wait too long, just call this tool again to mint a fresh one.\n" +
        "- The HTTP endpoint at /api/upload exists for the web app's drag-drop. Do NOT curl it from MCP — you don't have the user's API token, and you don't need it.\n",
      inputSchema: inputShape,
    },
    async (args, extra) => {
      const parsed = z.object(inputShape).safeParse(args);
      if (!parsed.success) return zodToToolError(parsed.error);
      const ctx = ctxFromAuthInfo(extra.authInfo);

      const result = await presignAttachmentUpload({
        userId: ctx.userId,
        filename: parsed.data.filename,
        mimeType: parsed.data.mime_type,
      });
      if (!result.ok) {
        const code =
          result.error.code === "storage_unavailable"
            ? "attachment_storage_unavailable"
            : result.error.code === "invalid_mime"
              ? "attachment_invalid_mime"
              : "internal_error";
        return toolError(code, result.error.message, {
          hint:
            code === "attachment_storage_unavailable"
              ? "Server is misconfigured (BLOB_READ_WRITE_TOKEN missing). Tell the user to set it; you can't recover from this."
              : code === "attachment_invalid_mime"
                ? "Convert the file to PDF / PNG / JPEG / WebP and retry."
                : "Retry once; if it fails again, surface the message verbatim to the user.",
        });
      }

      const p = result.presigned;
      return toolOk({
        upload: {
          method: p.method,
          url: p.url,
          headers: p.headers,
        },
        pathname: p.pathname,
        mime_type: p.mime_type,
        filename: p.filename,
        max_size_bytes: p.max_size_bytes,
        max_size_mb: Math.round(ATTACHMENT_MAX_BYTES / (1024 * 1024)),
        expires_at: p.expires_at,
        next_steps: [
          "PUT the file bytes to `upload.url` with the headers in `upload.headers`.",
          "Read the PUT response body — it is JSON with a `url` field.",
          "Pass that `url` as `attachment_url` when calling create_invoice / add_line_item / update_line_item.",
        ],
        curl_template:
          'curl -sS -X PUT "<upload.url>" -H "authorization: <upload.headers.authorization>" -H "x-api-version: 12" -H "x-content-type: <upload.headers.x-content-type>" -H "x-vercel-blob-access: public" --data-binary @/absolute/path/to/file',
      });
    },
  );
}
