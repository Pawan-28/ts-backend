/**
 * Read the JSON answer of a Gemini call, tolerating the ways it comes back damaged:
 *   - wrapped in a ```json fence
 *   - text before / after the object
 *   - cut off in the middle (the model ran out of output room on a long call)
 * Returns the parsed object, or null when nothing usable can be recovered.
 */
function parseGeminiJson(raw) {
  let text = String(raw ?? "").trim();
  if (!text) return null;
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

  const attempt = (s) => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" ? v : null;
    } catch {
      return null;
    }
  };

  const direct = attempt(text);
  if (direct) return direct;

  const start = text.indexOf("{");
  if (start < 0) return null;
  const end = text.lastIndexOf("}");
  if (end > start) {
    const sliced = attempt(text.slice(start, end + 1));
    if (sliced) return sliced;
  }
  return repairTruncated(text.slice(start));
}

/** Close a JSON text that stops half way: drop the unfinished last value, then close every open string / array / object. */
function repairTruncated(text) {
  const stack = [];
  let inString = false;
  let escaped = false;
  let lastSafe = -1; // index after the last complete value / separator at the current nesting
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      stack.pop();
      lastSafe = i + 1;
    } else if (ch === ",") lastSafe = i;
  }
  if (!stack.length) return null;

  const candidates = [];
  // keep everything that was complete, cut the unfinished tail
  if (lastSafe > 0) candidates.push(text.slice(0, lastSafe));
  // or close the half-written string right where it stops
  candidates.push(inString ? `${text}"` : text);
  for (const base of candidates) {
    let body = base.replace(/,\s*$/, "").replace(/:\s*$/, ": null");
    // the closers must match what is still open at the end of `body`
    const open = [];
    let s = false;
    let e = false;
    for (let i = 0; i < body.length; i += 1) {
      const ch = body[i];
      if (s) {
        if (e) e = false;
        else if (ch === "\\") e = true;
        else if (ch === '"') s = false;
        continue;
      }
      if (ch === '"') s = true;
      else if (ch === "{" || ch === "[") open.push(ch);
      else if (ch === "}" || ch === "]") open.pop();
    }
    if (s) body += '"';
    body = body.replace(/,\s*$/, "").replace(/:\s*$/, ": null");
    const closed = body + open.reverse().map((c) => (c === "{" ? "}" : "]")).join("");
    try {
      const v = JSON.parse(closed);
      if (v && typeof v === "object") return v;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

module.exports = { parseGeminiJson };
