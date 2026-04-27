import { put } from "@vercel/blob";
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { fileTypeFromBuffer } from "file-type";
import { nanoid } from "nanoid";
import type { NextRequest } from "next/server";
import { authenticateMcpRequest } from "@/lib/mcp/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Multipart path: bytes pass through this function. Vercel's platform caps
// the request body at 4.5 MB across all plans (https://vercel.com/docs/functions/runtimes#request-body-size).
// We refuse just under that with a clear hint pointing at the JSON path.
const MULTIPART_MAX_BYTES = 4 * 1024 * 1024;
// Direct-to-blob path: bytes go straight to Vercel Blob (vercel.com/api/blob),
// not through us, so this cap is whatever we want it to be.
const DIRECT_MAX_BYTES = 10 * 1024 * 1024;

const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
]);
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

/**
 * Attachment upload endpoint. Two modes, picked by Content-Type:
 *
 * (1) `multipart/form-data` with `file=@…` — easiest, works for files ≤ 4 MB.
 *     curl -X POST https://enwise.app/api/upload \
 *       -H "Authorization: Bearer env_live_…" \
 *       -F "file=@/path/to/receipt.pdf"
 *     → 200 {ok, url, mime_type, size_bytes, filename}
 *
 * (2) `application/json` `{filename, mime_type}` — for files > 4 MB (up to 10 MB).
 *     Returns a presigned PUT URL that bypasses Vercel's function body limit.
 *     curl -X POST https://enwise.app/api/upload \
 *       -H "Authorization: Bearer env_live_…" \
 *       -H "Content-Type: application/json" \
 *       -d '{"filename":"receipt.pdf","mime_type":"application/pdf"}'
 *     → 200 {ok, next_step: {method:"PUT", url, headers}, public_url, ...}
 *
 *     Then PUT the bytes:
 *     curl -X PUT "<next_step.url>" \
 *       -H "authorization: Bearer <token from headers>" \
 *       -H "x-api-version: 12" \
 *       -H "x-content-type: application/pdf" \
 *       -H "x-vercel-blob-access: public" \
 *       --data-binary @/path/to/receipt.pdf
 *     The PUT response body includes `url` — pass that as attachment_url.
 *
 * Both modes:
 *   - Bearer auth (same env_live_… token used for /api/mcp)
 *   - Allowed types: PNG, JPEG, WebP, PDF
 *   - NEVER chunk or split a file. If you can't fit a 10 MB upload, the
 *     endpoint will say so explicitly — don't try to base64 + slice.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const auth = await authenticateMcpRequest(request);
  if (!auth.ok) return auth.response;
  const ctx = auth.ctx;

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return json(503, {
      ok: false,
      error: "upload storage is not configured on this server.",
    });
  }

  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.startsWith("application/json")) {
    return handleDirectUpload(request, ctx.userId);
  }
  return handleMultipartUpload(request, ctx.userId);
}

async function handleDirectUpload(
  request: NextRequest,
  userId: string,
): Promise<Response> {
  let body: { filename?: unknown; mime_type?: unknown };
  try {
    body = await request.json();
  } catch {
    return json(400, {
      ok: false,
      error: "JSON body must include {filename, mime_type}.",
    });
  }
  const filename = typeof body.filename === "string" ? body.filename : null;
  const mimeType = typeof body.mime_type === "string" ? body.mime_type.toLowerCase() : null;
  if (!filename || !mimeType) {
    return json(400, {
      ok: false,
      error: "JSON body must include both `filename` and `mime_type`.",
    });
  }
  if (!ALLOWED_MIME.has(mimeType)) {
    return json(415, {
      ok: false,
      error: `Unsupported mime_type "${mimeType}". Allowed: PNG, JPEG, WebP, PDF.`,
    });
  }

  const ext = MIME_EXT[mimeType] ?? "bin";
  const pathname = `attachments/${userId}/${nanoid(16)}.${ext}`;
  const validUntil = Date.now() + 30 * 60 * 1000; // 30 min

  let clientToken: string;
  try {
    clientToken = await generateClientTokenFromReadWriteToken({
      token: process.env.BLOB_READ_WRITE_TOKEN!,
      pathname,
      validUntil,
      addRandomSuffix: false,
      allowOverwrite: false,
      maximumSizeInBytes: DIRECT_MAX_BYTES,
      allowedContentTypes: [mimeType],
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: `Failed to mint upload token: ${(err as Error).message}`,
    });
  }

  // Vercel Blob's API expects the pathname as a `?pathname=` query param,
  // not a path segment. Discovered by reading @vercel/blob/dist client.put.
  const putUrl = `https://vercel.com/api/blob/?pathname=${encodeURIComponent(pathname)}`;

  return json(200, {
    ok: true,
    next_step: {
      method: "PUT",
      url: putUrl,
      headers: {
        authorization: `Bearer ${clientToken}`,
        "x-api-version": "12",
        "x-content-type": mimeType,
        "x-vercel-blob-access": "public",
      },
      instructions:
        "PUT the file bytes to `url` with these `headers`. The PUT response body is JSON with a `url` field — pass that URL as `attachment_url` when creating / updating an invoice line item.",
    },
    pathname,
    mime_type: mimeType,
    filename,
    max_size_bytes: DIRECT_MAX_BYTES,
    expires_at: new Date(validUntil).toISOString(),
  });
}

async function handleMultipartUpload(
  request: NextRequest,
  userId: string,
): Promise<Response> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return json(400, {
      ok: false,
      error: "Expected multipart/form-data with a 'file' field.",
      hint: 'curl -X POST -H "Authorization: Bearer …" -F "file=@/path/to/file.pdf" /api/upload',
    });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return json(400, {
      ok: false,
      error: "Missing 'file' field in form data.",
    });
  }

  if (file.size > MULTIPART_MAX_BYTES) {
    return json(413, {
      ok: false,
      error: `File is ${formatBytes(file.size)}. Multipart cap is ${formatBytes(MULTIPART_MAX_BYTES)} (Vercel platform limit).`,
      hint:
        `For files larger than ${formatBytes(MULTIPART_MAX_BYTES)}, use the JSON mode (up to ${formatBytes(DIRECT_MAX_BYTES)}). POST application/json {filename, mime_type} to this same endpoint and follow the returned next_step.`,
    });
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // Trust the bytes, not the multipart content-type header — sniff the
  // actual file type and reject anything not in our allow list.
  const sniffed = await fileTypeFromBuffer(buffer);
  if (!sniffed || !ALLOWED_MIME.has(sniffed.mime)) {
    return json(415, {
      ok: false,
      error: "Unsupported file type. Allowed: PNG, JPEG, WebP, PDF.",
    });
  }

  const ext = MIME_EXT[sniffed.mime] ?? "bin";
  const pathname = `attachments/${userId}/${nanoid(16)}.${ext}`;

  let blobUrl: string;
  try {
    const result = await put(pathname, buffer, {
      access: "public",
      contentType: sniffed.mime,
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    blobUrl = result.url;
  } catch (err) {
    return json(500, {
      ok: false,
      error: `Upload to storage failed: ${(err as Error).message}`,
    });
  }

  // Try to preserve the original filename for the attachment label later.
  const filename = file.name || pathname.split("/").pop() || `upload.${ext}`;

  return json(200, {
    ok: true,
    url: blobUrl,
    mime_type: sniffed.mime,
    size_bytes: buffer.byteLength,
    filename,
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
