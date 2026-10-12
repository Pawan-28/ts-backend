/**
 * Central Indian phone normalization (backend). Mirrors frontend/src/lib/phoneUtils.js.
 *
 * The canonical Indian mobile is the LAST 10 DIGITS once the input is known to be
 * Indian. A number is treated as Indian when, after stripping every non-digit:
 *   - it is exactly 10 digits, or
 *   - it is longer and starts with the 91 country code (possibly repeated, e.g.
 *     "91919876543210" / "+91919876543210") or a trunk "0" / "0091" prefix.
 * International numbers written with another "+CC" (e.g. +65, +44, +1) are NOT Indian
 * and are left alone — the CRM supports several countries.
 *
 *   9876543210 / 919876543210 / +919876543210 / 91919876543210 / +91919876543210
 *   → "9876543210"
 */

function digitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

/** @returns {string|null} 10-digit Indian mobile, or null when not an Indian number. */
function toIndianMobile10(raw, countryCode = null) {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;

  let digits = digitsOnly(text);
  if (!digits) return null;

  const cc = digitsOnly(countryCode);
  if (cc && cc !== "91") return null; // explicitly another country

  const hasIntlPrefix = /^(\+|00)/.test(text);
  if (hasIntlPrefix) {
    if (text.startsWith("00")) digits = digits.replace(/^00/, "");
    return digits.startsWith("91") && digits.length >= 12 ? digits.slice(-10) : null;
  }

  if (digits.length === 10) return digits;
  if (digits.length > 10 && (digits.startsWith("91") || digits.startsWith("0"))) {
    return digits.slice(-10);
  }
  if (cc === "91" && digits.length > 10) return digits.slice(-10);
  return null;
}

/** "+919876543210" for Indian numbers; "+<digits>" for other international input. */
function toE164(raw) {
  const in10 = toIndianMobile10(raw);
  if (in10) return `+91${in10}`;
  const digits = digitsOnly(raw);
  return digits ? `+${digits.replace(/^00/, "")}` : "";
}

/** Callyzer contact / emp number format: "91-9876543210". */
function toCallyzerNumber(raw) {
  const in10 = toIndianMobile10(raw);
  if (in10) return `91-${in10}`;
  const d = digitsOnly(raw);
  if (!d) return null;
  if (d.length > 10) return `${d.slice(0, d.length - 10)}-${d.slice(-10)}`;
  return null;
}

/**
 * Is this phone number acceptable for a NEW lead? An Indian mobile must start with 6-9 (1234567890 / 0123456789 are typos);
 * another country's number (+65, +44 ...) and an empty value are left alone.
 */
function isPlausibleLeadPhone(raw) {
  if (raw == null || String(raw).trim() === "") return true;
  const in10 = toIndianMobile10(raw);
  return in10 == null || /^[6-9]\d{9}$/.test(in10);
}

/** A "name" made only of digits / + - ( ) spaces (at least 7 digits) is a phone number, not a person. */
function looksLikePhone(text) {
  const t = String(text ?? "").trim();
  return t.length > 0 && /^[+\d\s\-().]+$/.test(t) && digitsOnly(t).length >= 7;
}

/** The client name from a call log, or "Unknown Lead" when it is empty or just the phone number. */
function leadNameFromCallClient(clientName) {
  const name = String(clientName ?? "").trim();
  return name && !looksLikePhone(name) ? name : "Unknown Lead";
}

module.exports = {
  isPlausibleLeadPhone,
  looksLikePhone,
  leadNameFromCallClient,
  digitsOnly,
  toIndianMobile10,
  toE164,
  toCallyzerNumber,
};
