import { customAlphabet } from "nanoid";

const slugAlphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
const suffix = customAlphabet(slugAlphabet, 6);

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "business"
  );
}

export function uniqueSlug(input: string): string {
  return `${slugify(input)}-${suffix()}`;
}
