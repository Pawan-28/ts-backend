const pool = require("../../config/db");
const { logger } = require("../config/logger");

// AI Call Summary & MoM now runs on Google Gemini (was OpenAI Whisper + gpt-4o-mini).
// Key comes from the server environment only (GEMINI_API_KEY) — never sent to the
// frontend and never logged. The model can be overridden with GEMINI_CALL_MODEL.
// No fixed default model: the model is picked at runtime from the models this API key
// can actually use (GET /v1beta/models), so a retired/unavailable model never breaks
// the MoM again. GEMINI_CALL_MODEL (server env) still forces a specific model.
// gemini-2.5-flash is deliberately excluded from auto-selection (unavailable on this account).
const EXCLUDED_AUTO_MODELS = new Set(["gemini-2.5-flash"]);
const MODEL_LIST_TTL_MS = 6 * 60 * 60 * 1000;
let modelCache = { at: 0, candidates: [], working: null };
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";
// Inline audio must keep the whole request under ~20 MB; larger recordings go
// through the Gemini Files API instead.
const GEMINI_INLINE_AUDIO_MAX_BYTES = 14 * 1024 * 1024;

// Distinct, clearly-labeled placeholder messages per failure reason (previously these
// were all collapsed into one generic NO_RECORDING_MSG). Each one still contains a
// recognizable marker so ensureAllCallsProcessedWithAi()'s Pass 2 retry query (below)
// keeps catching and retrying them later, same as before.
const NO_RECORDING_MSG = "No call recording available for this call.";
const GEMINI_NOT_CONFIGURED_MSG = "[AI UNAVAILABLE] GEMINI_API_KEY is not configured on the server — no MoM was generated for this call.";
const TRANSCRIPT_UNAVAILABLE_MSG = "[TRANSCRIPT UNAVAILABLE] The call recording could not be transcribed (no speech detected or Gemini transcription failed) — no MoM was generated for this call.";
const AI_SUMMARY_PENDING_TAG = "[AI SUMMARY PENDING]";
const GPT_FAILED_MSG = "[GPT FAILED] AI summarization request failed — see server logs for details.";

const SECTION_LABELS = {
  callHeader: "CALL HEADER",
  discussionHighlights: "DISCUSSION HIGHLIGHTS & KEY REQUIREMENTS",
  qualificationsMet: "QUALIFICATIONS MET",
  actionItems: "ACTION ITEMS & NEXT STEPS",
};

function getCallAiModel() {
  return (process.env.GEMINI_CALL_MODEL || "").trim() || modelCache.working || "(auto)";
}

/** Parse "gemini-3.1-flash-001" → { major: 3, minor: 1 } for newest-first ordering. */
function modelVersion(name) {
  const m = String(name).match(/gemini-(\d+)(?:\.(\d+))?/);
  return m ? { major: Number(m[1]), minor: Number(m[2] || 0) } : { major: 0, minor: 0 };
}

/** Rank a model id: lower = preferred. Flash (fast, audio-capable) first, then Pro, then Flash-Lite. */
function modelRank(name) {
  const n = String(name);
  if (n === "gemini-flash-latest") return 0;
  if (n === "gemini-pro-latest") return 20;
  const isPreview = /-(preview|exp)/.test(n) ? 1 : 0;
  const base = n.replace(/-(preview|exp)[\w.-]*$/, "").replace(/-\d{3}$/, "");
  if (/-flash-lite$/.test(base)) return 40 + isPreview;
  if (/-flash$/.test(base)) return 10 + isPreview;
  if (/-pro$/.test(base)) return 30 + isPreview;
  return 90;
}

/**
 * Candidate models for this API key, best first: models that support generateContent,
 * excluding TTS / image / live / embedding / thinking-only variants and gemini-2.5-flash.
 */
async function listCandidateModels(apiKey, { refresh = false } = {}) {
  const forced = (process.env.GEMINI_CALL_MODEL || "").trim();
  if (forced) return [forced];
  if (!refresh && modelCache.candidates.length && Date.now() - modelCache.at < MODEL_LIST_TTL_MS) {
    return modelCache.working
      ? [modelCache.working, ...modelCache.candidates.filter((m) => m !== modelCache.working)]
      : modelCache.candidates;
  }
  const names = [];
  let pageToken = "";
  for (let page = 0; page < 5; page += 1) {
    const url = `${GEMINI_API_BASE}/v1beta/models?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const res = await fetch(url, { headers: geminiHeaders(apiKey) });
    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      const err = new Error(geminiErrorReason(res.status, errorText));
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    for (const m of data.models || []) {
      const id = String(m.name || "").replace(/^models\//, "");
      const methods = m.supportedGenerationMethods || [];
      if (!id.startsWith("gemini-") || !methods.includes("generateContent")) continue;
      if (/tts|image|live|embedding|audio-dialog|native-audio|computer-use|robotics|learnlm|aqa/i.test(id)) continue;
      if (EXCLUDED_AUTO_MODELS.has(id)) continue;
      names.push(id);
    }
    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }
  const candidates = [...new Set(names)]
    .filter((n) => modelRank(n) < 90)
    .sort((a, b) => {
      const ra = modelRank(a);
      const rb = modelRank(b);
      if (Math.floor(ra / 10) !== Math.floor(rb / 10)) return ra - rb;
      const va = modelVersion(a);
      const vb = modelVersion(b);
      if (vb.major !== va.major) return vb.major - va.major;
      if (vb.minor !== va.minor) return vb.minor - va.minor;
      return ra - rb;
    });
  modelCache = { at: Date.now(), candidates, working: candidates.includes(modelCache.working) ? modelCache.working : null };
  logger.info("Gemini models available for call MoM", { candidates: candidates.slice(0, 6) });
  return modelCache.working ? [modelCache.working, ...candidates.filter((m) => m !== modelCache.working)] : candidates;
}

/** Errors that mean "this model can't be used" → try the next available model. */
function isModelUnavailableError(status, errorText) {
  if (status === 404) return true;
  const t = String(errorText || "").toLowerCase();
  return (status === 400 || status === 403)
    && /(not found|not supported|no longer available|is not available|deprecated|unsupported model|does not exist|not have access)/.test(t)
    && !/mime|api key/.test(t);
}

function getGeminiApiKey() {
  return (process.env.GEMINI_API_KEY || "").trim();
}

function geminiHeaders(apiKey, extra = {}) {
  // Key travels in a header (not the URL) so it never shows up in logged URLs.
  return { "x-goog-api-key": apiKey, ...extra };
}

/** Concatenate the text parts of the first Gemini candidate. */
function geminiResponseText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("").trim();
}

/**
 * POST models/{model}:generateContent on the best model available to this key —
 * returns { ok, status, data, errorText, model }. If a model turns out to be
 * unavailable, the next candidate is tried automatically and remembered.
 */
async function geminiGenerateContent(apiKey, body) {
  let candidates;
  try {
    candidates = await listCandidateModels(apiKey);
  } catch (err) {
    return { ok: false, status: err.status || 500, data: null, errorText: JSON.stringify({ error: { message: `could not list Gemini models — ${err.message}` } }), model: null };
  }
  if (!candidates.length) {
    return { ok: false, status: 404, data: null, errorText: JSON.stringify({ error: { message: "no Gemini text/audio model is available for this API key" } }), model: null };
  }

  let last = null;
  for (const model of candidates.slice(0, 6)) {
    const res = await fetch(`${GEMINI_API_BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: geminiHeaders(apiKey, { "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (res.ok) {
      if (!(process.env.GEMINI_CALL_MODEL || "").trim()) modelCache.working = model;
      return { ok: true, status: res.status, data: await res.json(), errorText: "", model };
    }
    const errorText = (await res.text().catch(() => "")).slice(0, 1000);
    last = { ok: false, status: res.status, data: null, errorText, model };
    if (!isModelUnavailableError(res.status, errorText)) return last;
    logger.warn("Gemini model unavailable — trying next available model", { model, status: res.status });
    if (modelCache.working === model) modelCache.working = null;
    modelCache.candidates = modelCache.candidates.filter((m) => m !== model);
  }
  return last;
}

/**
 * Detect the real audio container from the file bytes (Callyzer/S3 often send
 * "application/octet-stream" or vendor types like "audio/x-m4a", which Gemini rejects).
 * Returns { format, mimeTypes: [...candidates in preferred order] }.
 */
function detectAudioFormat(buffer, contentType, url) {
  const b = buffer || Buffer.alloc(0);
  const ascii = (start, len) => b.slice(start, start + len).toString("latin1");
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return { format: "wav", mimeTypes: ["audio/wav"] };
  if (ascii(0, 4) === "OggS") return { format: "ogg", mimeTypes: ["audio/ogg"] };
  if (ascii(0, 4) === "fLaC") return { format: "flac", mimeTypes: ["audio/flac"] };
  if (ascii(0, 5) === "#!AMR") return { format: "amr", mimeTypes: ["audio/amr"] };
  if (ascii(4, 4) === "ftyp") return { format: "m4a", mimeTypes: ["audio/mp4", "audio/m4a", "audio/aac"] };
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { format: "webm", mimeTypes: ["audio/webm"] };
  if (ascii(0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0)) {
    return { format: "mp3", mimeTypes: ["audio/mp3", "audio/mpeg"] };
  }
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return { format: "aac", mimeTypes: ["audio/aac"] };

  // Unknown bytes — fall back to header / extension.
  const ct = String(contentType || "").split(";")[0].trim().toLowerCase();
  const ext = String(url || "").split("?")[0].split(".").pop().toLowerCase();
  const byKey = {
    mp3: ["audio/mp3", "audio/mpeg"], mpeg: ["audio/mp3", "audio/mpeg"], wav: ["audio/wav"], "x-wav": ["audio/wav"],
    m4a: ["audio/mp4", "audio/m4a", "audio/aac"], "x-m4a": ["audio/mp4", "audio/m4a", "audio/aac"], mp4: ["audio/mp4", "audio/aac"],
    aac: ["audio/aac"], ogg: ["audio/ogg"], flac: ["audio/flac"], amr: ["audio/amr"], webm: ["audio/webm"], "3gp": ["audio/3gpp"],
  };
  const fromCt = ct.startsWith("audio/") ? byKey[ct.slice(6)] : null;
  return { format: ext || ct || "unknown", mimeTypes: fromCt || byKey[ext] || ["audio/mp3", "audio/mpeg"] };
}

// ── Gemini charges (estimate from the API's usageMetadata) ─────────────────────────
// USD per 1M tokens. Defaults = Google's published paid-tier Gemini Flash rates; set the
// env vars to your account's actual rates. Thinking tokens are billed as output.
function geminiRates() {
  const num = (v, d) => (Number.isFinite(Number(v)) && String(v).trim() !== "" ? Number(v) : d);
  return {
    textIn: num(process.env.GEMINI_PRICE_TEXT_INPUT_PER_M, 0.30),
    audioIn: num(process.env.GEMINI_PRICE_AUDIO_INPUT_PER_M, 1.00),
    out: num(process.env.GEMINI_PRICE_OUTPUT_PER_M, 2.50),
    usdInr: num(process.env.USD_INR_RATE, 88),
  };
}

function usageCost(usage, rates) {
  if (!usage || !usage.promptTokenCount) return null;
  const details = Array.isArray(usage.promptTokensDetails) ? usage.promptTokensDetails : [];
  const audioIn = details.filter((d) => String(d.modality).toUpperCase() === "AUDIO").reduce((n, d) => n + (Number(d.tokenCount) || 0), 0);
  const textIn = Math.max((Number(usage.promptTokenCount) || 0) - audioIn, 0);
  const out = (Number(usage.candidatesTokenCount) || 0) + (Number(usage.thoughtsTokenCount) || 0);
  const usd = (textIn * rates.textIn + audioIn * rates.audioIn + out * rates.out) / 1e6;
  return { usd, audioIn, textIn, out, model: usage.model || null };
}

function fmtInr(usd, rate) {
  return `₹${(usd * rate).toFixed(2)}`;
}

/** "[GEMINI CHARGES]" text block, or "" when no Gemini call was made for this call. */
function buildGeminiChargesBlock(geminiUsage) {
  const rates = geminiRates();
  const t = usageCost(geminiUsage?.transcription, rates);
  const m = usageCost(geminiUsage?.mom, rates);
  if (!t && !m) return "";
  const totalUsd = (t?.usd || 0) + (m?.usd || 0);
  const tokens = (n) => Number(n || 0).toLocaleString("en-IN");
  const lines = [
    "[GEMINI CHARGES]",
    `Total: ${fmtInr(totalUsd, rates.usdInr)} ($${totalUsd.toFixed(4)}) (est.)`,
  ];
  if (t) lines.push(`Transcript: ${fmtInr(t.usd, rates.usdInr)} — ${tokens(t.audioIn)} audio + ${tokens(t.textIn)} text tokens in, ${tokens(t.out)} out`);
  if (m) lines.push(`MoM: ${fmtInr(m.usd, rates.usdInr)} — ${tokens(m.textIn)} tokens in, ${tokens(m.out)} out`);
  const model = m?.model || t?.model;
  if (model) lines.push(`Model: ${model}`);
  return lines.join("\n");
}

/** Short, key-free reason from a Gemini error body (shown on the call so failures are diagnosable). */
function geminiErrorReason(status, errorText) {
  let msg = "";
  try { msg = JSON.parse(errorText)?.error?.message || ""; } catch { msg = String(errorText || ""); }
  msg = msg.replace(/key=[^&\s]+/gi, "key=***").replace(/AIza[0-9A-Za-z_-]{20,}/g, "***").slice(0, 200);
  return `Gemini ${status}${msg ? `: ${msg}` : ""}`;
}

/** Upload a large recording through the Gemini Files API; returns { uri, mimeType }. */
async function geminiUploadFile(apiKey, buffer, mimeType, displayName) {
  const start = await fetch(`${GEMINI_API_BASE}/upload/v1beta/files`, {
    method: "POST",
    headers: geminiHeaders(apiKey, {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(buffer.length),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    }),
    body: JSON.stringify({ file: { display_name: displayName } }),
  });
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!start.ok || !uploadUrl) throw new Error(`Gemini file upload start failed (${start.status})`);

  const done = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(buffer.length),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: buffer,
  });
  if (!done.ok) throw new Error(`Gemini file upload failed (${done.status})`);
  let file = (await done.json())?.file;

  // Audio files are processed asynchronously — wait until ACTIVE (max ~60s).
  for (let i = 0; file && file.state === "PROCESSING" && i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    const poll = await fetch(`${GEMINI_API_BASE}/v1beta/${file.name}`, { headers: geminiHeaders(apiKey) });
    if (!poll.ok) break;
    file = await poll.json();
  }
  if (!file?.uri || (file.state && file.state !== "ACTIVE")) {
    throw new Error(`Gemini file not ready (state: ${file?.state || "unknown"})`);
  }
  return { uri: file.uri, mimeType: file.mimeType || mimeType };
}

/**
 * Transcribe a call recording with Gemini — replaces the former OpenAI Whisper step
 * at the same point in the flow (recording_url → transcript text → MoM).
 */
async function transcribeRecordingWithGemini(apiKey, recordingUrl, callId) {
  const audioRes = await fetch(recordingUrl);
  if (!audioRes.ok) {
    logger.warn("Could not download call recording for transcription", { callId, status: audioRes.status });
    return { text: "", reason: `recording download failed (HTTP ${audioRes.status})` };
  }
  const buffer = Buffer.from(await audioRes.arrayBuffer());
  if (!buffer.length) return { text: "", reason: "recording file is empty" };
  const { format, mimeTypes } = detectAudioFormat(buffer, audioRes.headers.get("content-type"), recordingUrl);

  const prompt = {
    text: "Transcribe this sales phone call recording verbatim in its original language(s) (Hindi, English or Hinglish). "
      + "Label speakers as 'Rep:' and 'Client:' where you can tell them apart. "
      + "Return ONLY the transcript text — no summary, no commentary. "
      + "If there is no intelligible speech, return an empty response.",
  };

  let lastReason = "";
  // Try each candidate MIME type; if Gemini rejects inline audio for a format, retry
  // the same format through the Files API before giving up.
  for (const mimeType of mimeTypes) {
    const attempts = buffer.length <= GEMINI_INLINE_AUDIO_MAX_BYTES ? ["inline", "file"] : ["file"];
    for (const mode of attempts) {
      let audioPart;
      try {
        if (mode === "inline") {
          audioPart = { inline_data: { mime_type: mimeType, data: buffer.toString("base64") } };
        } else {
          const uploaded = await geminiUploadFile(apiKey, buffer, mimeType, `call-${callId}`);
          audioPart = { file_data: { mime_type: uploaded.mimeType, file_uri: uploaded.uri } };
        }
      } catch (err) {
        lastReason = `Gemini file upload failed (${err.message})`;
        continue;
      }

      const result = await geminiGenerateContent(apiKey, {
        contents: [{ role: "user", parts: [audioPart, prompt] }],
        generationConfig: { temperature: 0 },
      });

      if (result.ok) {
        const usage = { model: result.model, ...(result.data?.usageMetadata || {}) };
        const text = geminiResponseText(result.data);
        if (text) return { text, reason: "", usage };
        const finish = result.data?.candidates?.[0]?.finishReason;
        const blocked = result.data?.promptFeedback?.blockReason;
        return {
          text: "",
          usage,
          reason: blocked ? `Gemini blocked the audio (${blocked})` : `no speech detected in the recording${finish && finish !== "STOP" ? ` (finish: ${finish})` : ""}`,
        };
      }

      lastReason = geminiErrorReason(result.status, result.errorText);
      logger.warn("Gemini transcription request failed", { callId, status: result.status, format, mimeType, mode, error: lastReason });
      // Auth / quota / model errors won't be fixed by another MIME type — stop early.
      if ([401, 403, 404, 429].includes(result.status) || result.status >= 500) {
        return { text: "", reason: lastReason };
      }
    }
  }
  return { text: "", reason: `${lastReason || "Gemini could not read the audio"} [format: ${format}]` };
}

/** The Service field stores a bare name today, but older leads may carry the
 *  legacy "[Service: X] notes" / "Service: X" prefix used by n8n ingestion. */
function extractServiceFromRequirements(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const bracketed = text.match(/^\[Service:\s*([^\]]+)\]/i);
  if (bracketed) return bracketed[1].trim();
  const prefixed = text.match(/^Service:\s*(.+)$/i);
  if (prefixed) return prefixed[1].trim();
  return text;
}

/** Find the SOP that should guide AI analysis for this lead's service — a SOP
 *  assigned to multiple services matches any of them; an exact match wins over
 *  a generic "All Services" SOP. `sops` has no tenant_id column (single-tenant table). */
async function findSopForService(tenantId, serviceName) {
  const result = await pool.query(
    `SELECT * FROM sops WHERE status <> 'Archived' ORDER BY updated_at DESC`,
  );
  const candidates = result.rows.map((row) => {
    let services = row.services;
    if (typeof services === "string") {
      try { services = JSON.parse(services); } catch { services = []; }
    }
    if (!Array.isArray(services) || !services.length) services = [row.service || "All Services"];
    return { row, services };
  });

  if (serviceName) {
    const exact = candidates.find((c) => c.services.includes(serviceName));
    if (exact) return exact.row;
  }
  const fallback = candidates.find((c) => c.services.includes("All Services"));
  return fallback?.row || null;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Build the "evaluate against this SOP" block injected into the AI prompt. */
function buildSopGuidanceBlock(sop) {
  if (!sop) {
    return { label: null, text: "No SOP is assigned to this lead's service yet — evaluate using general sales best practices." };
  }
  const questions = parseJsonArray(sop.questions);
  const frameworks = parseJsonArray(sop.frameworks);
  const lines = [
    `SOP Guidance: "${sop.title}" (${sop.category || "Sales Call"}) — service: ${sop.service || "All Services"}`,
  ];
  if (sop.script) lines.push(`Reference script:\n${sop.script}`);
  if (frameworks.length) lines.push(`Frameworks reps are trained to use: ${frameworks.join(", ")}`);
  if (questions.length) {
    lines.push(`Qualification checklist reps must cover on this type of call:\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`);
  }
  return { label: `${sop.title} (${sop.category || "Sales Call"})`, text: lines.join("\n\n") };
}

/** Flatten the structured 4-section summary object into the bracket-tagged plain-text
 *  format the ai_summary TEXT column (and existing frontend rendering) already expects —
 *  same convention already used by the "Not Connected" template below. Falls back to a
 *  plain string as-is if the model didn't return the expected object shape. */
function flattenSummaryForStorage(rawSummary) {
  if (rawSummary && typeof rawSummary === "object" && !Array.isArray(rawSummary)) {
    return Object.entries(rawSummary)
      .map(([k, v]) => `[${SECTION_LABELS[k] || k.toUpperCase()}]\n${typeof v === "object" ? JSON.stringify(v, null, 2) : v}`)
      .join("\n\n");
  }
  return String(rawSummary ?? "");
}

async function processCallWithAi(tenantId, callId) {
  const apiKey = getGeminiApiKey();

  // 1. Fetch the call log & associated lead info
  const callRes = await pool.query(
    `SELECT c.*, l.lead_name, l.phone as lead_phone, l.company_name, l.status as lead_status, l.notes as lead_notes, l.requirements as lead_requirements
     FROM employee_calls c
     LEFT JOIN leads l ON c.lead_id = l.id
     WHERE c.id = $1 AND (c.tenant_id = $2 OR c.tenant_id IS NULL) LIMIT 1`,
    [callId, tenantId]
  );
  if (callRes.rows.length === 0) {
    const err = new Error("Call log not found");
    err.status = 404;
    throw err;
  }
  const call = callRes.rows[0];
  const leadService = extractServiceFromRequirements(call.lead_requirements);
  const matchedSop = await findSopForService(tenantId, leadService);
  const sopGuidance = buildSopGuidanceBlock(matchedSop);

  const clientName = call.lead_name || call.notes || "Client";
  const durationSec = Number(call.duration_sec) || 0;
  const durationStr = `${Math.floor(durationSec / 60)}:${String(durationSec % 60).padStart(2, "0")}`;
  const dateStr = new Date(call.started_at || call.created_at || Date.now()).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const timeStr = new Date(call.started_at || call.created_at || Date.now()).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
  });

  const rawOutcome = String(call.outcome || "").trim();
  const isNotConnected =
    /not connected|missed|rejected|unanswered|busy|failed/i.test(rawOutcome) ||
    (durationSec <= 5 && !call.recording_url);

  const effectiveOutcome = isNotConnected
    ? (rawOutcome && !/connected/i.test(rawOutcome) ? rawOutcome : "Not Connected")
    : (rawOutcome || "Connected");

  let transcript = "";
  let transcriptSource = null; // "existing" | "gemini" | null
  let transcriptFailReason = "";
  const geminiUsage = { transcription: null, mom: null }; // for "Gemini charges" on the MoM
  let summaryText = NO_RECORDING_MSG;
  let structuredSummary = null;
  let sentiment = "neutral";
  let rating = 0;
  let temperature = "Warm Lead";
  let checklistProgress = [];
  let competencyScores = {};

  const existingTranscript = String(call.transcript || "").trim();
  const hasUsableTranscript = Boolean(existingTranscript);
  const hasRecording = Boolean(call.recording_url && String(call.recording_url).trim());

  if (hasUsableTranscript) {
    // Transcript/words are already on the call record (e.g. supplied by the call source
    // directly, or entered previously) — use that text for Gemini directly. Do NOT require a
    // recording URL, and do NOT re-transcribe, when we already have usable transcript text.
    logger.info("Using existing transcript already present on the call record — skipping transcription", { callId });
    transcript = existingTranscript;
    transcriptSource = "existing";
  } else if (isNotConnected || !hasRecording) {
    logger.info("Call is not connected or no recording present — set clear Not Connected summary", { callId });
    summaryText = `[CALL STATUS: NOT CONNECTED]
• Client: ${clientName}
• Call Ref: #${call.id} | Date: ${dateStr} | Duration: ${durationStr} (Not Connected)
• Status: ${effectiveOutcome}

[CALL LOG SUMMARY]
• Call attempt was not connected or not answered by the client.
• No live audio conversation was recorded for this call log.

[RECOMMENDED ACTION ITEMS]
1. Re-attempt call or send a follow-up WhatsApp message.`;
    transcript = "";
    rating = 0;
  } else {
    // No existing transcript, but a recording URL exists — transcribe with Gemini
    // (audio → text), then summarize that transcript below exactly as before.
    if (!apiKey) {
      logger.warn("GEMINI_API_KEY not configured — cannot transcribe recording", { callId });
      summaryText = GEMINI_NOT_CONFIGURED_MSG;
    } else {
      try {
        logger.info("Downloading audio recording for Gemini transcription", { callId, recordingUrl: call.recording_url });
        const tr = await transcribeRecordingWithGemini(apiKey, call.recording_url, callId);
        transcript = String(tr?.text || "").trim();
        transcriptFailReason = tr?.reason || "";
        if (tr?.usage) geminiUsage.transcription = tr.usage;
        if (transcript) transcriptSource = "gemini";
      } catch (err) {
        transcriptFailReason = err.message;
        logger.warn("Gemini transcription failed for recording", { callId, error: err.message });
      }

      if (!transcript) {
        // Keep the [TRANSCRIPT UNAVAILABLE] marker (background retry relies on it) and
        // append the concrete reason so the failure is visible on the call.
        if (/^no speech detected/i.test(transcriptFailReason)) {
          // Genuinely silent/unintelligible audio — not an error, so no retry marker
          // (avoids re-sending the same silent recording to Gemini on every sync).
          summaryText = `[NO SPEECH DETECTED]\nCall Date: ${dateStr} at ${timeStr}\nDuration: ${durationStr}\n\nThe recording was processed but contained no intelligible conversation, so no MoM was generated.`;
        } else {
          summaryText = transcriptFailReason
            ? `${TRANSCRIPT_UNAVAILABLE_MSG}\nReason: ${transcriptFailReason}`
            : TRANSCRIPT_UNAVAILABLE_MSG;
        }
      }
    }
  }

  // Gemini summarization — runs whenever we ended up with usable transcript text, regardless
  // of whether it came from the call record directly or from Gemini transcription above.
  // Same prompt and same JSON output contract as the previous OpenAI call, so the stored
  // columns and the Lead Details "AI Call Summary & MoM" UI are unchanged.
  if (transcript) {
    if (!apiKey) {
      logger.warn("GEMINI_API_KEY not configured — cannot generate MoM from transcript", { callId });
      summaryText = GEMINI_NOT_CONFIGURED_MSG;
    } else {
      // If Gemini fails, store a short English placeholder (NOT the raw Hindi/Hinglish
      // transcript — that stays in the transcript column). The marker lets the
      // background retry pick it up again.
      const aiPendingSummary = `${AI_SUMMARY_PENDING_TAG}\nCall Date: ${dateStr} at ${timeStr}\nDuration: ${durationStr}\n\nThe AI summary for this call could not be generated yet. Click "Re-process AI MoM" to try again.`;
      try {
        logger.info("Generating MoM from transcript with Gemini", { callId, transcriptSource, model: getCallAiModel() });
        const systemPrompt = `You are an AI sales compliance & MoM generator for TS Publications CRM. Analyze the REAL transcript below for client "${clientName}".
Generate a detailed, structured, professional Minutes of Meeting (MoM) containing ONLY facts discussed in the transcript.
Do NOT invent or hallucinate facts outside the transcript. If something was not discussed, write "Not discussed on the call" instead of guessing.

LANGUAGE:
- The conversation (and transcript) is usually in HINDI or HINGLISH — the client does not need to speak English. Understand it fully in the original language.
- Write ALL MoM output (every "summary" section and every checklist "note") in clear, professional ENGLISH. Translate and summarize the meaning of what was said; never output Hindi/Devanagari text and never paste raw transcript lines.
- Preserve every important detail exactly: names, company/brand/service names, amounts and pricing (e.g. "₹45,000 + 18% GST"), quantities (e.g. "13-14 newspapers"), dates, times, deadlines, commitments and follow-ups.

${sopGuidance.text}

Generate:
1. "summary": a JSON OBJECT (not a single string) with EXACTLY these four keys, each a detailed multi-line string in English. Use the sub-headings shown, with bullet points ("• ") under each; include every relevant detail from the call (requirements, prices quoted, packages, timelines, platforms, decision-maker info, etc.):
   - "callHeader":
       first line: Date: ${dateStr} | Time: ${timeStr} | Client: ${clientName} | Duration: ${durationStr}${sopGuidance.label ? ` | SOP: ${sopGuidance.label}` : ""}
       then "Call Summary:" — 3-5 lines describing the purpose of the call, what happened and the overall outcome.
   - "discussionHighlights":
       "Key Discussion Points:" — every important topic discussed, in order;
       "Customer Requirements:" — what the client needs/asked for (service, budget, timeline, platform, quantity);
       "Customer Concerns / Objections:" — doubts, objections or hesitations and how the rep responded (write "No objections raised" if none).
   - "qualificationsMet":
       "SOP Evaluation:" — go through the SOP qualification checklist above (if any) and state which items were covered and which were missed, quoting/paraphrasing where each was addressed;
       "Rep Performance:" — 2-3 lines on the rep's strengths and what to improve on this call.
   - "actionItems":
       "Next Steps:" — agreed next steps with dates/times if mentioned;
       "Action Items:" — numbered tasks, each with the owner (Rep / Client) and deadline if stated.
2. "sentiment": "positive" | "neutral" | "negative"
3. "rating": integer 1-5
4. "temperature": "Hot Lead" | "Warm Lead" | "Cold Lead"
5. "checklistProgress": for EACH item in the SOP qualification checklist above, an object { "question": <the checklist item text exactly as given>, "covered": true|false, "note": "<one line in English on what was said, or empty if not covered>" }. Return an empty array if no checklist was provided.
6. "competencyScores": score the rep 0-100 on each of these five fixed dimensions, judged against the SOP script/frameworks/checklist above where provided:
   - "Product Value Alignment": how well the rep tied the product/service to the client's stated needs
   - "Call Control": did the rep guide the conversation and the agenda rather than being led
   - "Listening Skills": evidence the rep listened and responded to what the client actually said (not scripted talk-over)
   - "KYC Questioning": did the rep ask discovery/qualification questions to understand the client's situation
   - "Objection Handling": how well any pushback or hesitation from the client was addressed
   Use 0 for a dimension only if the call gave no signal either way (e.g. call ended immediately).

Return JSON with exact keys:
{
  "summary": {
    "callHeader": "...",
    "discussionHighlights": "...",
    "qualificationsMet": "...",
    "actionItems": "..."
  },
  "sentiment": "positive",
  "rating": 5,
  "temperature": "Hot Lead",
  "checklistProgress": [{ "question": "...", "covered": true, "note": "..." }],
  "competencyScores": {
    "Product Value Alignment": 70,
    "Call Control": 65,
    "Listening Skills": 80,
    "KYC Questioning": 55,
    "Objection Handling": 60
  }
}`;
        const geminiRes = await geminiGenerateContent(apiKey, {
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: `Real Transcript:\n${transcript}` }] }],
          generationConfig: {
            // Equivalent of OpenAI response_format: json_object.
            responseMimeType: "application/json",
            temperature: 0.2,
          },
        });

        if (geminiRes.ok) {
          geminiUsage.mom = { model: geminiRes.model, ...(geminiRes.data?.usageMetadata || {}) };
          const content = geminiResponseText(geminiRes.data);
          if (!content) {
            logger.error("Gemini returned an empty response body", {
              callId,
              finishReason: geminiRes.data?.candidates?.[0]?.finishReason || null,
              blockReason: geminiRes.data?.promptFeedback?.blockReason || null,
            });
            summaryText = aiPendingSummary;
          } else {
            let analysis;
            try {
              // Tolerate a ```json fenced block, just in case.
              analysis = JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
            } catch (parseErr) {
              logger.error("Gemini returned invalid JSON", { callId, error: parseErr.message, content });
              analysis = null;
            }
            if (!analysis || typeof analysis !== "object") {
              summaryText = aiPendingSummary;
            } else {
              const rawSummary = analysis.summary ?? transcript;
              if (rawSummary && typeof rawSummary === "object" && !Array.isArray(rawSummary)) {
                structuredSummary = rawSummary;
              }
              summaryText = flattenSummaryForStorage(rawSummary);
              sentiment = analysis.sentiment || "positive";
              rating = Number(analysis.rating) || 5;
              temperature = analysis.temperature || "Warm Lead";
              checklistProgress = Array.isArray(analysis.checklistProgress) ? analysis.checklistProgress : [];
              competencyScores = (analysis.competencyScores && typeof analysis.competencyScores === "object")
                ? analysis.competencyScores
                : {};
            }
          }
        } else {
          logger.error("Gemini API request failed", { callId, status: geminiRes.status, error: geminiRes.errorText });
          summaryText = aiPendingSummary;
        }
      } catch (err) {
        logger.error("Gemini summarization threw an error", { callId, error: err.message });
        summaryText = aiPendingSummary;
      }
    }
  }

  // Per-call Gemini charges, shown at the TOP of the MoM (stored inside ai_summary as a
  // "[GEMINI CHARGES]" block — no schema change). Only when Gemini was actually called.
  const chargesBlock = buildGeminiChargesBlock(geminiUsage);
  if (chargesBlock) summaryText = `${chargesBlock}\n\n${summaryText}`;

  // Update employee_calls in DB
  try {
    await pool.query(
      `UPDATE employee_calls
       SET transcript = $1, notes = $2, ai_summary = $3, outcome = $4, duration_sec = COALESCE(NULLIF(duration_sec, 0), $5),
           sop_id = $6, checklist_progress = $7, competency_scores = $8
       WHERE id = $9`,
      [
        String(transcript), summaryText, summaryText, effectiveOutcome, durationSec,
        matchedSop?.id || null, JSON.stringify(checklistProgress), JSON.stringify(competencyScores), callId,
      ]
    );
  } catch (err) {
    logger.error("Failed to save AI analysis results to employee_calls", { callId, error: err.message });
    const wrapped = new Error(`Failed to save AI analysis results: ${err.message}`);
    wrapped.status = 500;
    throw wrapped;
  }

  // Update lead in DB if real recording transcript was processed
  if (call.lead_id && transcript && transcriptSource) {
    await pool.query(
      `UPDATE leads
       SET temperature = $1, status = COALESCE(NULLIF(status, ''), 'contacted'), updated_at = NOW()
       WHERE id = $2`,
      [temperature, call.lead_id]
    );
  }

  const updatedRes = await pool.query(
    "SELECT * FROM employee_calls WHERE id = $1 LIMIT 1",
    [callId]
  );
  // structuredSummary carries the 4-section object (callHeader/discussionHighlights/
  // qualificationsMet/actionItems) alongside the flattened ai_summary text already on the
  // row, so API consumers get real structure without any schema change — ai_summary
  // itself stays a plain TEXT column, unchanged, fully backward compatible with old rows.
  return { ...updatedRes.rows[0], structuredSummary };
}

async function ensureAllCallsProcessedWithAi(tenantId = "default") {
  try {
    // Pass 1: calls with no ai_summary at all (null or empty)
    const unanalyzed = await pool.query(
      `SELECT id FROM employee_calls
       WHERE (tenant_id = $1 OR tenant_id IS NULL)
         AND (ai_summary IS NULL OR ai_summary = '' OR notes IS NULL OR notes = '')
       ORDER BY id DESC LIMIT 100`,
      [tenantId]
    );
    for (const row of unanalyzed.rows) {
      try {
        await processCallWithAi(tenantId, row.id);
      } catch (e) {
        logger.warn("Failed auto processing for call", { callId: row.id, error: e.message });
      }
    }

    // Pass 2: calls that HAVE a recording_url but still show a placeholder/failure message
    // instead of a real summary. These occur when AI ran before the recording was
    // available, or a transient Whisper/GPT/config failure left a placeholder behind —
    // all of the placeholder markers used above are included here so every one of them
    // gets retried once the underlying condition (recording, API key, etc.) is fixed.
    const recordingButPlaceholder = await pool.query(
      `SELECT id FROM employee_calls
       WHERE (tenant_id = $1 OR tenant_id IS NULL)
         AND (
           (
             recording_url IS NOT NULL AND recording_url <> ''
             AND (
               ai_summary IS NULL OR ai_summary = ''
               OR ai_summary LIKE '%No call recording%'
               OR ai_summary LIKE '%no_summary%'
               OR ai_summary LIKE '%[AI UNAVAILABLE]%'
               OR ai_summary LIKE '%[TRANSCRIPT UNAVAILABLE]%'
               OR ai_summary LIKE '%[GPT FAILED]%'
               OR notes LIKE '%No call recording%'
             )
           )
           -- Summaries that fell back to the raw (often Hindi) transcript, or the new
           -- English "pending" placeholder: regenerate as a proper English MoM.
           OR (
             transcript IS NOT NULL AND transcript <> ''
             AND (
               ai_summary LIKE '[TRANSCRIPT ON FILE]%'
               OR ai_summary LIKE '[REAL AUDIO TRANSCRIPT]%'
               OR ai_summary LIKE '%[AI SUMMARY PENDING]%'
             )
           )
         )
       ORDER BY id DESC LIMIT 100`,
      [tenantId]
    );
    for (const row of recordingButPlaceholder.rows) {
      try {
        await processCallWithAi(tenantId, row.id);
      } catch (e) {
        logger.warn("Failed reprocessing call with recording", { callId: row.id, error: e.message });
      }
    }
  } catch (err) {
    logger.error("ensureAllCallsProcessedWithAi failed", { error: err.message });
  }
}

module.exports = {
  processCallWithAi,
  ensureAllCallsProcessedWithAi,
};
