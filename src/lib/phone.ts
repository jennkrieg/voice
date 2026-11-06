/** Normalise to E.164. Numbers without a country code are treated as US/Canada (+1). */
export function toE164(input: string | null | undefined, defaultCountryCode = "1"): string | null {
  if (!input) return null;
  const trimmed = String(input).trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  if (trimmed.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (trimmed.startsWith("00")) return toE164(`+${digits.slice(2)}`);
  if (defaultCountryCode === "1") {
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  }
  return digits.length >= 8 && digits.length <= 15 ? `+${defaultCountryCode}${digits}` : null;
}
