import { put } from "@vercel/blob";
import { fileTypeFromBuffer } from "file-type";
import { nanoid } from "nanoid";
import type { NextRequest } from "next/server";
import { authenticateMcpRequest } from "@/lib/mcp/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vercel Hobby caps Server Function bodies at ~4.5 MB. Stay below that.
const MAX_BYTES = 4 * 1024 * 1024;

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
 * Direct upload endpoint for attachments. Claude (or any MCP client with
 * shell access) curls a file straight from disk so the bytes never have
 * to pass through the model's context window:
 *
 *   curl -X POST https://enwise.app/api/upload \\
 *     -H "Authorization: Bearer env_live_…" \\
 *     -F "file=@/path/to/receipt.pdf"
 *
 * Returns `{ url, mime_type, size_bytes, filename }`. Pass the `url` as
 * `attachment_url` when creating / updating an invoice line item.
 *
 * Limits (matches what the create_invoice tool accepts):
 * - PNG, JPEG, WebP, PDF only
 * - 4 MB max
 * - Bearer auth (same env_live_… token used for /api/mcp)
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

  if (file.size > MAX_BYTES) {
    return json(413, {
      ok: false,
      error: `File is ${formatBytes(file.size)}. Max is ${formatBytes(MAX_BYTES)}.`,
    });
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // Trust the bytes, not the multipart content-type header — sniff the
  // actual file type and reject anything not in our allow list.
  const sniffed = await fileTypeFromBuffer(buffer);
  if (!sniffed || !ALLOWED_MIME.has(sniffed.mime)) {
    return json(415, {
      ok: false,
      error:
        "Unsupported file type. Allowed: PNG, JPEG, WebP, PDF.",
    });
  }

  const ext = MIME_EXT[sniffed.mime] ?? "bin";
  const pathname = `attachments/${ctx.userId}/${nanoid(16)}.${ext}`;

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
