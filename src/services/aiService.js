const pool = require("../../config/db");
const { logger } = require("../config/logger");

const DEFAULT_CALL_AI_MODEL = "gpt-4o-mini";

// Distinct, clearly-labeled placeholder messages per failure reason (previously these
// were all collapsed into one generic NO_RECORDING_MSG). Each one still contains a
// recognizable marker so ensureAllCallsProcessedWithAi()'s Pass 2 retry query (below)
// keeps catching and retrying them later, same as before.
const NO_RECORDING_MSG = "No call recording available for this call.";
const OPENAI_NOT_CONFIGURED_MSG = "[AI UNAVAILABLE] OPENAI_API_KEY is not configured on the server — no MoM was generated for this call.";
const TRANSCRIPT_UNAVAILABLE_MSG = "[TRANSCRIPT UNAVAILABLE] The call recording could not be transcribed (no speech detected or Whisper failed) — no MoM was generated for this call.";
const GPT_FAILED_MSG = "[GPT FAILED] AI summarization request failed — see server logs for details.";

const SECTION_LABELS = {
  callHeader: "CALL HEADER",
  discussionHighlights: "DISCUSSION HIGHLIGHTS & KEY REQUIREMENTS",
  qualificationsMet: "QUALIFICATIONS MET",
  actionItems: "ACTION ITEMS & NEXT STEPS",
};

function getCallAiModel() {
  return process.env.OPENAI_CALL_MODEL || DEFAULT_CALL_AI_MODEL;
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
  const apiKey = process.env.OPENAI_API_KEY;

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
  let transcriptSource = null; // "existing" | "whisper" | null
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
    // directly, or entered previously) — use that text for GPT directly. Do NOT require a
    // recording URL, and do NOT re-run Whisper, when we already have usable transcript text.
    logger.info("Using existing transcript already present on the call record — skipping Whisper", { callId });
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
    // No existing transcript, but a recording URL exists — transcribe with Whisper.
    if (!apiKey) {
      logger.warn("OPENAI_API_KEY not configured — cannot transcribe recording", { callId });
      summaryText = OPENAI_NOT_CONFIGURED_MSG;
    } else {
      try {
        logger.info("Downloading audio recording for Whisper transcription", { callId, recordingUrl: call.recording_url });
        const audioRes = await fetch(call.recording_url);
        if (audioRes.ok) {
          const arrayBuffer = await audioRes.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);

          const formData = new FormData();
          const fileBlob = new Blob([buffer], { type: "audio/mp3" });
          formData.append("file", fileBlob, "recording.mp3");
          formData.append("model", "whisper-1");

          const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}` },
            body: formData,
          });

          if (whisperRes.ok) {
            const whisperData = await whisperRes.json();
            transcript = (whisperData.text || "").trim();
            if (transcript) transcriptSource = "whisper";
          } else {
            const errText = await whisperRes.text().catch(() => "");
            logger.warn("Whisper transcription request failed", { callId, status: whisperRes.status, error: errText });
          }
        } else {
          logger.warn("Could not download call recording for transcription", { callId, status: audioRes.status });
        }
      } catch (err) {
        logger.warn("Whisper transcription failed for recording", { callId, error: err.message });
      }

      if (!transcript) {
        summaryText = TRANSCRIPT_UNAVAILABLE_MSG;
      }
    }
  }

  // GPT summarization — runs whenever we ended up with usable transcript text, regardless
  // of whether it came from the call record directly or from Whisper above.
  if (transcript) {
    if (!apiKey) {
      logger.warn("OPENAI_API_KEY not configured — cannot generate MoM from transcript", { callId });
      summaryText = OPENAI_NOT_CONFIGURED_MSG;
    } else {
      const transcriptFallbackTag = transcriptSource === "existing" ? "[TRANSCRIPT ON FILE]" : "[REAL AUDIO TRANSCRIPT]";
      try {
        const callAiModel = getCallAiModel();
        logger.info("Generating MoM from transcript with GPT", { callId, transcriptSource, model: callAiModel });
        const gptRes = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: callAiModel,
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content: `You are an AI sales compliance & MoM generator for TS Publications CRM. Analyze the REAL transcript below for client "${clientName}".
Generate a structured Minutes of Meeting (MoM) containing ONLY facts discussed in the transcript.
Do NOT invent or hallucinate facts outside the transcript.

${sopGuidance.text}

Generate:
1. "summary": a JSON OBJECT (not a single string) with EXACTLY these four keys, each a string:
   - "callHeader": one line covering Date: ${dateStr}, Time: ${timeStr}, Client: ${clientName}, Duration: ${durationStr}${sopGuidance.label ? `, SOP Guidance Used: ${sopGuidance.label}` : ""}
   - "discussionHighlights": Discussion Highlights & Key Requirements from the call
   - "qualificationsMet": go through the SOP's qualification checklist above (if any) and state which items were actually covered on the call and which were missed — quote or paraphrase where each was addressed
   - "actionItems": Action Items & Next Steps
2. "sentiment": "positive" | "neutral" | "negative"
3. "rating": integer 1-5
4. "temperature": "Hot Lead" | "Warm Lead" | "Cold Lead"
5. "checklistProgress": for EACH item in the SOP qualification checklist above, an object { "question": <the checklist item text>, "covered": true|false, "note": "<one line on what was said, or empty if not covered>" }. Return an empty array if no checklist was provided.
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
}`,
              },
              {
                role: "user",
                content: `Real Transcript:\n${transcript}`,
              },
            ],
          }),
        });

        if (gptRes.ok) {
          const gptData = await gptRes.json();
          const content = gptData?.choices?.[0]?.message?.content;
          if (!content) {
            logger.error("GPT returned an empty response body", { callId, gptData });
            summaryText = `${transcriptFallbackTag}\nCall Date: ${dateStr} at ${timeStr}\nDuration: ${durationStr}\n\n${transcript}`;
          } else {
            let analysis;
            try {
              analysis = JSON.parse(content);
            } catch (parseErr) {
              logger.error("GPT returned invalid JSON", { callId, error: parseErr.message, content });
              analysis = null;
            }
            if (!analysis || typeof analysis !== "object") {
              summaryText = `${transcriptFallbackTag}\nCall Date: ${dateStr} at ${timeStr}\nDuration: ${durationStr}\n\n${transcript}`;
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
          const errText = await gptRes.text().catch(() => "");
          logger.error("GPT API request failed", { callId, status: gptRes.status, error: errText });
          summaryText = `${transcriptFallbackTag}\nCall Date: ${dateStr} at ${timeStr}\nDuration: ${durationStr}\n\n${transcript}`;
        }
      } catch (err) {
        logger.error("GPT summarization threw an error", { callId, error: err.message });
        summaryText = `${transcriptFallbackTag}\nCall Date: ${dateStr} at ${timeStr}\nDuration: ${durationStr}\n\n${transcript}`;
      }
    }
  }

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
         AND recording_url IS NOT NULL AND recording_url <> ''
         AND (
           ai_summary IS NULL OR ai_summary = ''
           OR ai_summary LIKE '%No call recording%'
           OR ai_summary LIKE '%no_summary%'
           OR ai_summary LIKE '%[AI UNAVAILABLE]%'
           OR ai_summary LIKE '%[TRANSCRIPT UNAVAILABLE]%'
           OR ai_summary LIKE '%[GPT FAILED]%'
           OR notes LIKE '%No call recording%'
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
