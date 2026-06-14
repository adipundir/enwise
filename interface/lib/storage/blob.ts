import { lookup } from "node:dns/promises";
import net from "node:net";
import { put } from "@vercel/blob";
import { fileTypeFromBuffer } from "file-type";
import { nanoid } from "nanoid";

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB (logo)
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

export type LogoInput =
  | { image_url: string }
  | { image_base64: string; mime_type: string };

export type LogoResult =
  | { ok: true; url: string }
  | {
      ok: false;
      code:
        | "logo_too_large"
        | "logo_invalid_mime"
        | "logo_fetch_failed"
        | "logo_storage_unavailable";
      message: string;
      hint?: string;
    };

export async function uploadLogo(params: {
  businessId: string;
  input: LogoInput;
}): Promise<LogoResult> {
  const { input, businessId } = params;
  const hasBlob = Boolean(process.env.BLOB_READ_WRITE_TOKEN);

  if ("image_url" in input) {
    return handleUrl(businessId, input.image_url, hasBlob);
  }
  if (!hasBlob) {
    return {
      ok: false,
      code: "logo_storage_unavailable",
      message:
        "Logo upload via base64 requires Vercel Blob storage, which isn't configured on this server yet.",
      hint: "Use `logo: { image_url: 'https://…' }` instead. pass a public URL and it will be stored verbatim.",
    };
  }
  return handleBase64(businessId, input.image_base64, input.mime_type);
}

async function handleUrl(
  businessId: string,
  url: string,
  hasBlob: boolean,
): Promise<LogoResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      ok: false,
      code: "logo_fetch_failed",
      message: "image_url is not a valid URL.",
    };
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return {
      ok: false,
      code: "logo_fetch_failed",
      message: "image_url must be http:// or https://",
    };
  }
  // SSRF guard: resolve hostname and reject private / loopback / link-local / metadata IPs.
  const ssrfCheck = await verifyHostIsPublic(parsed.hostname);
  if (!ssrfCheck.ok) {
    return {
      ok: false,
      code: "logo_fetch_failed",
      message: ssrfCheck.reason,
    };
  }

  let res: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      res = await fetch(parsed, {
        method: "GET",
        redirect: "follow",
        headers: { accept: "image/png,image/jpeg,image/webp,image/*;q=0.1" },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    const msg = (err as Error).name === "AbortError"
      ? "Request timed out after 15 seconds."
      : `Couldn't fetch the image: ${(err as Error).message}`;
    return { ok: false, code: "logo_fetch_failed", message: msg };
  }
  // Re-check the final URL after redirects to prevent SSRF via open redirectors.
  if (res.url && res.url !== parsed.href) {
    let finalUrl: URL;
    try { finalUrl = new URL(res.url); } catch {
      return { ok: false, code: "logo_fetch_failed", message: "Redirect led to an invalid URL." };
    }
    const recheck = await verifyHostIsPublic(finalUrl.hostname);
    if (!recheck.ok) {
      return { ok: false, code: "logo_fetch_failed", message: recheck.reason };
    }
  }
  if (!res.ok) {
    return {
      ok: false,
      code: "logo_fetch_failed",
      message: `Fetching the image returned HTTP ${res.status}.`,
    };
  }
  const declaredLength = Number(res.headers.get("content-length") || "0");
  if (declaredLength && declaredLength > MAX_BYTES) {
    return {
      ok: false,
      code: "logo_too_large",
      message: `Image is ${formatBytes(declaredLength)}, max is 2 MB.`,
    };
  }

  const buffer = await readBoundedBuffer(res.body, MAX_BYTES);
  if (!buffer.ok) return buffer.error;

  const mimeCheck = await validateMime(buffer.data);
  if (!mimeCheck.ok) return mimeCheck.error;

  if (!hasBlob) {
    // Local-dev fallback: trust the source URL.
    return { ok: true, url };
  }

  return uploadToBlob(businessId, buffer.data, mimeCheck.mime);
}

async function handleBase64(
  businessId: string,
  base64: string,
  declaredMime: string,
): Promise<LogoResult> {
  if (!ALLOWED_MIME.has(declaredMime)) {
    return mimeError();
  }
  const clean = base64.replace(/^data:[^;]+;base64,/, "");
  let buffer: Buffer;
  try {
    buffer = Buffer.from(clean, "base64");
  } catch {
    return {
      ok: false,
      code: "logo_invalid_mime",
      message: "image_base64 isn't valid base64.",
    };
  }
  if (buffer.byteLength > MAX_BYTES) {
    return {
      ok: false,
      code: "logo_too_large",
      message: `Decoded image is ${formatBytes(buffer.byteLength)}, max is 2 MB.`,
    };
  }
  const mimeCheck = await validateMime(buffer);
  if (!mimeCheck.ok) return mimeCheck.error;
  // Extra paranoia: claimed mime must match sniffed mime.
  if (mimeCheck.mime !== declaredMime) {
    return {
      ok: false,
      code: "logo_invalid_mime",
      message: `Declared mime_type ${declaredMime} doesn't match actual file contents (${mimeCheck.mime}).`,
    };
  }
  return uploadToBlob(businessId, buffer, mimeCheck.mime);
}

async function readBoundedBuffer(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<
  | { ok: true; data: Buffer }
  | { ok: false; error: Extract<LogoResult, { ok: false }> }
> {
  if (!body) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "logo_fetch_failed",
        message: "Response body was empty.",
      },
    };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return {
        ok: false,
        error: {
          ok: false,
          code: "logo_too_large",
          message: `Image exceeds ${formatBytes(limit)} while downloading.`,
        },
      };
    }
    chunks.push(value);
  }
  return { ok: true, data: Buffer.concat(chunks) };
}

async function validateMime(buffer: Uint8Array): Promise<
  | { ok: true; mime: string }
  | { ok: false; error: Extract<LogoResult, { ok: false }> }
> {
  const sniffed = await fileTypeFromBuffer(buffer);
  if (!sniffed || !ALLOWED_MIME.has(sniffed.mime)) {
    return { ok: false, error: mimeError() };
  }
  return { ok: true, mime: sniffed.mime };
}

async function uploadToBlob(
  businessId: string,
  buffer: Buffer,
  mime: string,
): Promise<LogoResult> {
  const ext = MIME_EXT[mime] ?? "bin";
  const pathname = `logos/${businessId}/${nanoid(16)}.${ext}`;
  try {
    const result = await put(pathname, buffer, {
      access: "public",
      contentType: mime,
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    return { ok: true, url: result.url };
  } catch (err) {
    return {
      ok: false,
      code: "logo_storage_unavailable",
      message: `Upload to blob storage failed: ${(err as Error).message}`,
    };
  }
}

function mimeError(): Extract<LogoResult, { ok: false }> {
  return {
    ok: false,
    code: "logo_invalid_mime",
    message: "Logo must be PNG, JPEG, or WebP.",
    hint: "SVG is not supported in v1. Convert your logo and try again.",
  };
}

// ---------- Line item attachments ----------

export type AttachmentInput = {
  label?: string;
  /** URL returned by POST /api/upload. Must be on our own Blob host. */
  attachment_url: string;
};

export type AttachmentResolved = { label: string; url: string };

export type AttachmentResult =
  | { ok: true; attachment: AttachmentResolved }
  | {
      ok: false;
      code:
        | "attachment_too_large"
        | "attachment_invalid_mime"
        | "attachment_storage_unavailable";
      message: string;
      hint?: string;
    };

/** Hosts we mint our own URLs on (Vercel Blob serves under these domains). */
const TRUSTED_BLOB_HOSTS = [
  ".public.blob.vercel-storage.com",
  ".blob.vercel-storage.com",
];

function isTrustedBlobUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    return TRUSTED_BLOB_HOSTS.some((h) => u.hostname.endsWith(h));
  } catch {
    return false;
  }
}

/**
 * Validates a pre-uploaded blob URL and packages it as a `LineItemAttachment`.
 * Bytes never enter the model's context — Claude (or any MCP client) curls
 * the file to POST /api/upload, gets back a URL, then passes that URL here.
 * Only enwise's own Vercel Blob hosts are accepted (defends against the
 * old URL-passthrough surface where attackers could inject phishing links).
 */
export async function resolveAttachment(params: {
  businessId: string;
  input: AttachmentInput;
}): Promise<AttachmentResult> {
  const { input } = params;
  if (!isTrustedBlobUrl(input.attachment_url)) {
    return {
      ok: false,
      code: "attachment_invalid_mime",
      message:
        "attachment_url must be a URL returned by POST /api/upload (only enwise blob hosts accepted).",
      hint: 'Upload the file first: curl -X POST -H "Authorization: Bearer <TOKEN>" -F "file=@/path/to/file.pdf" https://enwise.app/api/upload — then pass the returned `url` as `attachment_url`.',
    };
  }
  return {
    ok: true,
    attachment: {
      label: input.label?.trim() || "Attachment",
      url: input.attachment_url,
    },
  };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Reject any hostname that resolves to a private, loopback, link-local, or
 * cloud-metadata address. Runs before we fetch so we never hand an
 * attacker-supplied URL to node's http client.
 */
async function verifyHostIsPublic(
  hostname: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const host = hostname.toLowerCase();

  // Short-circuit obvious hostnames.
  if (
    host === "localhost" ||
    host === "metadata.google.internal" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    return { ok: false, reason: `Host ${hostname} is not a public address.` };
  }

  // If the hostname is already a literal IP, check it.
  const ipFamily = net.isIP(host);
  if (ipFamily !== 0) {
    return ipBlocked(host)
      ? { ok: false, reason: `Host ${hostname} resolves to a non-public address.` }
      : { ok: true };
  }

  let resolved: { address: string; family: number }[];
  try {
    resolved = await lookup(host, { all: true, verbatim: true });
  } catch {
    return { ok: false, reason: `Couldn't resolve host ${hostname}.` };
  }
  for (const r of resolved) {
    if (ipBlocked(r.address)) {
      return {
        ok: false,
        reason: `Host ${hostname} resolves to a non-public address.`,
      };
    }
  }
  return { ok: true };
}

function ipBlocked(addr: string): boolean {
  const family = net.isIP(addr);
  if (family === 4) return ipv4Blocked(addr);
  if (family === 6) return ipv6Blocked(addr);
  return true;
}

function ipv4Blocked(addr: string): boolean {
  const parts = addr.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  // 0.0.0.0/8. current-network / unspecified
  if (a === 0) return true;
  // 10.0.0.0/8. RFC1918 private
  if (a === 10) return true;
  // 127.0.0.0/8. loopback
  if (a === 127) return true;
  // 169.254.0.0/16. link-local, cloud metadata (AWS/GCP IMDS)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12. RFC1918 private
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16. RFC1918 private
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10. CGNAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 192.0.0.0/24, 192.0.2.0/24, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24. IANA special
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51) return true;
  if (a === 203 && b === 0) return true;
  // 224.0.0.0/4. multicast
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4. reserved
  if (a >= 240) return true;
  return false;
}

function ipv6Blocked(addr: string): boolean {
  const lower = addr.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  // fc00::/7 unique local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // fe80::/10 link-local
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true;
  // ff00::/8 multicast
  if (lower.startsWith("ff")) return true;
  // IPv4-mapped (::ffff:a.b.c.d). fall through to IPv4 rules
  const v4mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped) return ipv4Blocked(v4mapped[1]!);
  return false;
}
