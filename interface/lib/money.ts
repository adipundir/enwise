/**
 * Money utilities. All internal arithmetic is done on string-encoded
 * numeric(14,2) values via BigInt (scale = 100) to avoid IEEE float drift.
 * Zero-decimal currencies (JPY, KRW, etc.) are handled by Intl formatter.
 */

const ISO_4217 = /^[A-Z]{3}$/;

export function isValidCurrency(code: string): boolean {
  return ISO_4217.test(code);
}

/** Convert a numeric(14,2) string like "2499.99" to minor units as BigInt. */
export function toMinor(amount: string): bigint {
  if (!/^-?\d+(\.\d+)?$/.test(amount)) {
    throw new Error(`invalid amount: ${amount}`);
  }
  const [intPart, decPart = ""] = amount.split(".");
  const padded = (decPart + "00").slice(0, 2);
  return BigInt(`${intPart}${padded}`);
}

/** Convert minor-units BigInt back to numeric(14,2) string. */
export function fromMinor(minor: bigint): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const s = abs.toString().padStart(3, "0");
  const int = s.slice(0, -2);
  const dec = s.slice(-2);
  return `${neg ? "-" : ""}${int}.${dec}`;
}

export function addAmounts(...amounts: string[]): string {
  return fromMinor(amounts.reduce((acc, a) => acc + toMinor(a), 0n));
}

/**
 * Apply a tax rate (stored as numeric(6,4) string e.g. "0.0825") to a subtotal
 * string. Rounds half-to-even to two decimals.
 */
export function multiplyRate(subtotal: string, rate: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(rate)) {
    throw new Error(`invalid rate: ${rate}`);
  }
  // Subtotal is scaled *100; rate is *10000 when decimals trimmed.
  const subMinor = toMinor(subtotal);
  const [rInt, rDec = ""] = rate.split(".");
  const rDecPadded = (rDec + "0000").slice(0, 4);
  const rateScaled = BigInt(`${rInt}${rDecPadded}`);
  // subtotal * rate = (subMinor / 100) * (rateScaled / 10000)
  // → result_minor = (subMinor * rateScaled) / 1_000_000 * 100 = (subMinor * rateScaled) / 10000
  const product = subMinor * rateScaled;
  // Round half-to-even on dividing by 10_000.
  const divisor = 10_000n;
  const q = product / divisor;
  const rem = product % divisor;
  const halfway = divisor / 2n;
  let rounded = q;
  if (rem > halfway || (rem === halfway && q % 2n !== 0n)) {
    rounded += rem < 0n ? -1n : 1n;
  }
  return fromMinor(rounded);
}

export function multiplyQuantity(quantity: string, unitPrice: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(quantity)) {
    throw new Error(`invalid quantity: ${quantity}`);
  }
  const priceMinor = toMinor(unitPrice);
  const [qInt, qDec = ""] = quantity.split(".");
  const qDecPadded = (qDec + "0000").slice(0, 4);
  const qScaled = BigInt(`${qInt}${qDecPadded}`);
  const product = priceMinor * qScaled;
  const divisor = 10_000n;
  const q = product / divisor;
  const rem = product % divisor;
  const halfway = divisor / 2n;
  let rounded = q;
  if (rem > halfway || (rem === halfway && q % 2n !== 0n)) {
    rounded += rem < 0n ? -1n : 1n;
  }
  return fromMinor(rounded);
}

/**
 * Format an amount for display. Locale defaults to en-US; callers can override
 * (e.g. based on recipient's Accept-Language on the public invoice page).
 */
export function formatMoney(
  amount: string,
  currency: string,
  locale = "en-US",
): string {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return `${amount} ${currency}`;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
    }).format(numeric);
  } catch {
    return `${amount} ${currency}`;
  }
}

export interface LineItemMath {
  lineSubtotal: string;
  lineTax: string;
  lineTotal: string;
}

export function computeLine(input: {
  quantity: string;
  unitPrice: string;
  taxRate: string;
}): LineItemMath {
  const lineSubtotal = multiplyQuantity(input.quantity, input.unitPrice);
  const lineTax = multiplyRate(lineSubtotal, input.taxRate);
  const lineTotal = addAmounts(lineSubtotal, lineTax);
  return { lineSubtotal, lineTax, lineTotal };
}
