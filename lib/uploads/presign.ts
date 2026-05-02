import "server-only";
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { nanoid } from "nanoid";

/**
 * Presigned-PUT minting for attachment uploads.
 *
 * Shared by:
 *   - app/api/upload (HTTP, JSON mode) — for the web app's drag-drop
 *     and any non-MCP scripts.
 *   - lib/mcp/tools/uploads.ts (MCP tool `request_attachment_upload`) — the
 *     canonical path for Claude / agents.
 *
 * The minted client token is short-lived and scoped to one pathname / mime /
 * max size, signed by the server's BLOB_READ_WRITE_TOKEN. The caller (browser
 * or model) PUTs bytes directly to vercel.com/api/blob — bytes never traverse
 * our function, and the long-lived blob token never leaves the server.
 */

export const ALLOWED_ATTACHMENT_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
]);

export const ATTACHMENT_MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

// Hard cap. Vercel's function body limit is 4.5 MB, but presigned PUTs go
// directly to blob storage and bypass that — so 10 MB here is a product
// choice (keeps invoice attachments reasonable), not a platform constraint.
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

// 30 minutes. Long enough for a slow upload over a flaky connection, short
// enough that a leaked URL stops being useful before anyone notices.
const PRESIGN_TTL_MS = 30 * 60 * 1000;

export type PresignedUpload = {
  method: "PUT";
  url: string;
  headers: {
    authorization: string;
    "x-api-version": string;
    "x-content-type": string;
    "x-vercel-blob-access": string;
  };
  pathname: string;
  mime_type: string;
  filename: string;
  max_size_bytes: number;
  expires_at: string;
};

export type PresignError =
  | { code: "storage_unavailable"; message: string }
  | { code: "invalid_mime"; message: string }
  | { code: "mint_failed"; message: string };

export type PresignResult =
  | { ok: true; presigned: PresignedUpload }
  | { ok: false; error: PresignError };

export async function presignAttachmentUpload(input: {
  userId: string;
  filename: string;
  mimeType: string;
}): Promise<PresignResult> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return {
      ok: false,
      error: {
        code: "storage_unavailable",
        message: "Upload storage is not configured on this server.",
      },
    };
  }

  const mimeType = input.mimeType.toLowerCase();
  if (!ALLOWED_ATTACHMENT_MIME.has(mimeType)) {
    return {
      ok: false,
      error: {
        code: "invalid_mime",
        message: `Unsupported mime_type "${input.mimeType}". Allowed: PNG, JPEG, WebP, PDF.`,
      },
    };
  }

  const ext = ATTACHMENT_MIME_EXT[mimeType] ?? "bin";
  const pathname = `attachments/${input.userId}/${nanoid(16)}.${ext}`;
  const validUntil = Date.now() + PRESIGN_TTL_MS;

  let clientToken: string;
  try {
    clientToken = await generateClientTokenFromReadWriteToken({
      token: process.env.BLOB_READ_WRITE_TOKEN,
      pathname,
      validUntil,
      addRandomSuffix: false,
      allowOverwrite: false,
      maximumSizeInBytes: ATTACHMENT_MAX_BYTES,
      allowedContentTypes: [mimeType],
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "mint_failed",
        message: `Failed to mint upload token: ${(err as Error).message}`,
      },
    };
  }

  // Vercel Blob's API expects pathname as a `?pathname=` query param, not a
  // path segment. Discovered by reading @vercel/blob/dist client.put.
  const putUrl = `https://vercel.com/api/blob/?pathname=${encodeURIComponent(pathname)}`;

  return {
    ok: true,
    presigned: {
      method: "PUT",
      url: putUrl,
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-api-version": "12",
        "x-content-type": mimeType,
        "x-vercel-blob-access": "public",
      },
      pathname,
      mime_type: mimeType,
      filename: input.filename,
      max_size_bytes: ATTACHMENT_MAX_BYTES,
      expires_at: new Date(validUntil).toISOString(),
    },
  };
}
