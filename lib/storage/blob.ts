import { put } from "@vercel/blob";
import { fileTypeFromBuffer } from "file-type";
import { nanoid } from "nanoid";

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
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
      hint: "Use `logo: { image_url: 'https://…' }` instead — pass a public URL and it will be stored verbatim.",
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

  let res: Response;
  try {
    res = await fetch(parsed, {
      method: "GET",
      headers: { accept: "image/png,image/jpeg,image/webp,image/*;q=0.1" },
    });
  } catch (err) {
    return {
      ok: false,
      code: "logo_fetch_failed",
      message: `Couldn't fetch the image: ${(err as Error).message}`,
    };
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
