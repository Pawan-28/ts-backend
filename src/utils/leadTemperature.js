/**
 * Lead temperature = how soon the customer is likely to PAY. Decided by Gemini from what the customer said on a connected call.
 *
 *   Hot            - will pay within 7 days
 *   Warm           - will pay within 30 days
 *   Cold           - might pay within 90 days
 *   Not Interested - the customer is not interested
 *
 * Stored on leads.temperature as the same labels the CRM already uses ("Hot Lead" / "Warm Lead" / "Cold Lead" / "Not Interested").
 * Older rows hold "hot" / "warm" / "cold" / "Hot Lead" ... - normalizeTemperature reads all of them.
 */
const LABELS = { hot: "Hot Lead", warm: "Warm Lead", cold: "Cold Lead", not_interested: "Not Interested" };
const PAY_WINDOW_DAYS = { hot: 7, warm: 30, cold: 90 };

/** Any spelling of a temperature -> "hot" | "warm" | "cold" | "not_interested" | null (unknown / empty). */
function normalizeTemperature(raw) {
  const s = String(raw ?? "").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (s === "ni" || s.includes("not interested") || s.includes("notinterested") || s.includes("uninterested")) return "not_interested";
  if (s.includes("hot")) return "hot";
  if (s.includes("warm")) return "warm";
  if (s.includes("cold")) return "cold";
  return null;
}

/** The label stored on leads.temperature for a normalised key (or any spelling). null when it is not a temperature. */
function temperatureLabel(raw) {
  const key = LABELS[raw] ? raw : normalizeTemperature(raw);
  return key ? LABELS[key] : null;
}

/** The Gemini instructions for the "temperature" field of the call analysis. */
function temperaturePromptBlock() {
  return `4. "temperature": how soon THIS customer is likely to PAY, judged ONLY from what the customer said on the call (their own words about budget, decision, payment, timeline, urgency):
   - "Hot Lead": will pay within 7 days (ready to buy / asked for payment details / agreed to pay or decide this week).
   - "Warm Lead": will pay within 30 days (interested, comparing or waiting for approval, but a decision within about a month).
   - "Cold Lead": might pay within 90 days (vague interest, "later", no payment timeline, or only information-gathering).
   - "Not Interested": the customer clearly said they are not interested / do not want the service.
   Never guess: if the call does not show a clear timeline, choose the COLDER of the options that fit. Use exactly one of these four strings.`;
}

module.exports = { LABELS, PAY_WINDOW_DAYS, normalizeTemperature, temperatureLabel, temperaturePromptBlock };
