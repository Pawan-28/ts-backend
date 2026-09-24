const pool = require("../../config/db");
const { logger } = require("../config/logger");

const DEFAULT_CALL_AI_MODEL = "gpt-4o-mini";
const NO_RECORDING_MSG = "No call recording available for this call.";

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
    throw new Error("Call log not found");
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
  let summaryText = NO_RECORDING_MSG;
  let sentiment = "neutral";
  let rating = 0;
  let temperature = "Warm Lead";
  let checklistProgress = [];
  let competencyScores = {};

  const hasRecording = Boolean(call.recording_url && String(call.recording_url).trim());

  if (isNotConnected || !hasRecording) {
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
    // Has audio recording URL! Transcribe using Whisper
    if (apiKey) {
      try {
        logger.info("Downloading audio recording for Whisper transcription", { recordingUrl: call.recording_url });
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
          }
        }
      } catch (err) {
        logger.warn("Whisper transcription failed for recording", { error: err.message });
      }
    }

    if (!transcript) {
      // Audio could not be transcribed or had no spoken speech
      summaryText = NO_RECORDING_MSG;
      transcript = "";
    } else {
      // Real Whisper transcript obtained! Pass to GPT to generate genuine MoM
      try {
        const callAiModel = getCallAiModel();
        logger.info("Generating REAL MoM from audio transcript with GPT", { callId });
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
                content: `You are an AI sales compliance & MoM generator for TS Publications CRM. Analyze the REAL audio transcript below for client "${clientName}".
Generate a structured Minutes of Meeting (MoM) containing ONLY facts discussed in the transcript.
Do NOT invent or hallucinate facts outside the audio transcript.

${sopGuidance.text}

Generate:
1. "summary": A structured Minutes of Meeting (MoM):
   - Call Header (Date: ${dateStr}, Time: ${timeStr}, Client: ${clientName}, Duration: ${durationStr})
   ${sopGuidance.label ? `- SOP Guidance Used: ${sopGuidance.label}` : ""}
   - Discussion Highlights & Key Requirements
   - Qualifications Met: go through the SOP's qualification checklist above (if any) and state which items were actually covered on the call and which were missed — quote or paraphrase where each was addressed
   - Action Items & Next Steps
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
  "summary": "...",
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
                content: `Real Audio Transcript:\n${transcript}`,
              },
            ],
          }),
        });

        if (gptRes.ok) {
          const gptData = await gptRes.json();
          const analysis = JSON.parse(gptData.choices[0].message.content);
          const rawSummary = analysis.summary || transcript;
          summaryText = typeof rawSummary === "object"
            ? Object.entries(rawSummary).map(([k, v]) => `[${k}]\n${typeof v === "object" ? JSON.stringify(v, null, 2) : v}`).join("\n\n")
            : String(rawSummary);
          sentiment = analysis.sentiment || "positive";
          rating = Number(analysis.rating) || 5;
          temperature = analysis.temperature || "Warm Lead";
          checklistProgress = Array.isArray(analysis.checklistProgress) ? analysis.checklistProgress : [];
          competencyScores = (analysis.competencyScores && typeof analysis.competencyScores === "object")
            ? analysis.competencyScores
            : {};
        } else {
          summaryText = `[REAL AUDIO TRANSCRIPT]\nCall Date: ${dateStr} at ${timeStr}\nDuration: ${durationStr}\n\n${transcript}`;
        }
      } catch (err) {
        summaryText = `[REAL AUDIO TRANSCRIPT]\nCall Date: ${dateStr} at ${timeStr}\nDuration: ${durationStr}\n\n${transcript}`;
      }
    }
  }

  // Update employee_calls in DB
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

  // Update lead in DB if real recording transcript was processed
  if (call.lead_id && hasRecording && transcript) {
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
  return updatedRes.rows[0];
}

async function ensureAllCallsProcessedWithAi(tenantId = "default") {
  const NO_RECORDING_MSG_PATTERN = "No call recording";
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

    // Pass 2: calls that HAVE a recording_url but still show placeholder/no-recording message
    // These occur when AI ran before the recording was available
    const recordingButPlaceholder = await pool.query(
      `SELECT id FROM employee_calls 
       WHERE (tenant_id = $1 OR tenant_id IS NULL) 
         AND recording_url IS NOT NULL AND recording_url <> ''
         AND (
           ai_summary IS NULL OR ai_summary = ''
           OR ai_summary LIKE '%No call recording%'
           OR ai_summary LIKE '%no_summary%'
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
