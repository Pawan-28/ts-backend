const pdfParse = require("pdf-parse");
const { logger } = require("../config/logger");

const DEFAULT_MODEL = "gpt-4o-mini";

function getOpenAiKey() {
  return process.env.OPENAI_API_KEY || "";
}

function getOpenAiModel() {
  return process.env.OPENAI_CALL_MODEL || DEFAULT_MODEL;
}

/**
 * Extract raw text from uploaded document buffer (PDF, TXT, DOCX, etc.)
 */
async function extractTextFromDocument(fileBuffer, originalFilename = "", mimeType = "") {
  const isPdf =
    (mimeType && mimeType.includes("pdf")) ||
    (originalFilename && originalFilename.toLowerCase().endsWith(".pdf"));

  if (isPdf) {
    try {
      const data = await pdfParse(fileBuffer);
      const text = (data.text || "").trim();
      logger.info("Extracted text from PDF document", {
        pages: data.numpages,
        chars: text.length,
        filename: originalFilename,
      });
      return {
        text,
        numPages: data.numpages || 1,
        info: data.info || {},
      };
    } catch (err) {
      logger.error("Failed to parse PDF with pdf-parse", { error: err.message, filename: originalFilename });
      // Fallback: convert buffer to string
      const raw = fileBuffer.toString("utf-8");
      return { text: raw, numPages: 1, info: {} };
    }
  }

  // Text, markdown, csv, or plain text
  const text = fileBuffer.toString("utf-8").trim();
  return { text, numPages: 1, info: {} };
}

/**
 * Heuristic fallback parser when OpenAI is unavailable
 */
function heuristicParseSop(rawText, filename = "") {
  const cleanFilename = (filename || "")
    .replace(/\.[^/.]+$/, "")
    .replace(/[_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const lines = (rawText || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let title = cleanFilename || "Standard Operating Procedure Document";
  if (lines.length > 0 && lines[0].length < 80 && !lines[0].includes("?")) {
    title = lines[0];
  }

  const questions = [];
  const qaPairs = [];
  const scripts = [];
  const steps = [];
  const frameworks = [];
  const tags = new Set(["SOP", "playbook", "process"]);

  let currentScriptContent = [];
  let currentScriptHeading = "Standard Interaction Script";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect questions
    if (
      line.endsWith("?") ||
      /^q\d*[:.-]/i.test(line) ||
      /^question\d*[:.-]/i.test(line) ||
      /^(what|why|how|when|where|who|which|can|could|do|does|did|is|are|would)/i.test(line)
    ) {
      const qText = line.replace(/^(q\d*[:.-]|question\d*[:.-])\s*/i, "").trim();
      if (qText.length > 5 && !questions.includes(qText)) {
        questions.push(qText);
      }

      // Check if next line is an answer
      const nextLine = lines[i + 1];
      if (nextLine && (/^(a\d*[:.-]|ans\d*[:.-]|answer[:.-])/i.test(nextLine) || !nextLine.endsWith("?"))) {
        const aText = nextLine.replace(/^(a\d*[:.-]|ans\d*[:.-]|answer[:.-])\s*/i, "").trim();
        qaPairs.push({ question: qText, answer: aText });
      }
    }

    // Detect steps
    if (/^(\d+[\.\)]|step\s*\d+[:.-]|phase\s*\d+[:.-]|[-*•])\s+/i.test(line)) {
      const stepText = line.replace(/^(\d+[\.\)]|step\s*\d+[:.-]|phase\s*\d+[:.-]|[-*•])\s+/i, "").trim();
      if (stepText.length > 5) {
        steps.push({ step: steps.length + 1, title: stepText });
      }
    }

    // Detect dialogue / scripts
    if (/^(agent|rep|caller|executive|seller|advisor|author|client|customer|lead)[:\-]/i.test(line)) {
      currentScriptContent.push(line);
    }

    // Detect frameworks
    if (/\b(BANT|SPIN|MEDDIC|MEDDPICC|LAER|Challenger|Sandler|GPCT|AIDA)\b/i.test(line)) {
      const matched = line.match(/\b(BANT|SPIN|MEDDIC|MEDDPICC|LAER|Challenger|Sandler|GPCT|AIDA)\b/gi);
      matched.forEach((m) => frameworks.push(m.toUpperCase()));
    }
  }

  if (currentScriptContent.length > 0) {
    scripts.push({
      heading: currentScriptHeading,
      content: currentScriptContent.join("\n"),
    });
  }

  if (steps.length === 0) {
    steps.push(
      { step: 1, title: "Review document objectives and stakeholder requirements" },
      { step: 2, title: "Execute procedure steps as documented in the playbook" },
      { step: 3, title: "Log outcomes and interaction details in the CRM" }
    );
  }

  const description = lines.slice(0, 3).join(" ") || `Standard Operating Procedure extracted from ${filename}.`;

  return {
    title,
    description: description.slice(0, 500),
    category: "Sales Call",
    status: "Draft",
    priority: "Medium",
    department: "Operations",
    estimated_time: "20 min",
    scripts: scripts.length ? scripts : [{ heading: "Standard Call Script", content: currentScriptContent.join("\n") || "Agent: Hello, thank you for reaching out..." }],
    script: currentScriptContent.join("\n") || "",
    questions: questions.length ? questions : ["What is the primary objective of this procedure?"],
    questions_answers: qaPairs,
    frameworks: Array.from(new Set(frameworks)),
    instruction_steps: steps,
    tags: Array.from(tags),
    services: ["All Services"],
    full_content: rawText,
  };
}

/**
 * Parse document with OpenAI GPT-4o-mini to extract ALL content, Q&A, scripts, steps
 */
async function parseSopDocumentWithAi(rawText, originalFilename = "") {
  const apiKey = getOpenAiKey();

  if (!apiKey || !rawText || rawText.trim().length === 0) {
    logger.info("Using heuristic SOP parser (no API key or empty text)");
    return heuristicParseSop(rawText, originalFilename);
  }

  const truncatedText = rawText.slice(0, 45000); // gpt-4o-mini context safe window

  const systemPrompt = `You are a world-class Sales Operations, Publishing, and Standard Operating Procedure (SOP) AI Architect.
Your mission is to analyze the provided document text (extracted from an uploaded procedure PDF/file named "${originalFilename}") and extract ALL actionable procedures, dialogue scripts, qualification/discovery questions, question-and-answer pairs, objection handling, frameworks, checklist steps, and full content without losing ANY key information.

You must respond ONLY with a valid JSON object matching this exact schema:
{
  "title": "A precise, professional title for the SOP (e.g. 'Book Launch With Chetan Bhagat', 'Enterprise Lead Qualification')",
  "description": "A comprehensive, high-quality summary and scope explaining what this SOP covers, who it applies to, and the primary objective.",
  "category": "Sales Call" | "After Call" | "During Meeting" | "After Meeting" | "After Closing",
  "priority": "Critical" | "High" | "Medium" | "Low",
  "department": "Department or function (e.g. Sales, Publishing Operations, Business Development, Customer Success, Editorial)",
  "estimated_time": "Estimated execution or review duration (e.g. '15 min', '30 min', '45 min', '1 hr')",
  "scripts": [
    {
      "heading": "Descriptive Heading for this script stage (e.g. 'Opening Hook & Greeting', 'Value Proposition & Pitch', 'Handling Author/Client Objections', 'Closing & Commitment')",
      "content": "Word-for-word spoken dialogue script with Agent/Rep and Client/Lead/Author turns"
    }
  ],
  "script": "Complete unified dialogue script representing the core conversation flow",
  "questions": [
    "List of every discovery, qualification, compliance, screening, or interview question found in or derived from the document."
  ],
  "questions_answers": [
    {
      "question": "Question or objection topic covered in the document",
      "answer": "Detailed answer, guideline, response script, or resolution from the document"
    }
  ],
  "frameworks": [
    "Frameworks, methodologies, rules, or criteria mentioned (e.g. 'BANT Qualification', 'SPIN Selling', 'Launch Event Protocol', 'LAER Objection Handling')"
  ],
  "instruction_steps": [
    {
      "step": 1,
      "title": "Step title and actionable instruction detailing what the rep/manager must do"
    }
  ],
  "tags": ["relevant", "keywords", "tags", "identifying", "this", "sop"],
  "services": ["Specific service name or 'All Services'"],
  "full_content": "A beautifully formatted, complete Markdown document preserving the full hierarchy, all sections, Q&A, scripts, and details from the source document so zero information is lost."
}

CRITICAL RULES:
1. DO NOT return generic placeholder text like 'Describe the purpose'. Extract REAL content from the document.
2. If the document has dialogue or pitch lines, extract them into 'scripts' with stage headings.
3. If the document has questions and answers, objection responses, or FAQs, extract EVERY SINGLE ONE into both 'questions' and 'questions_answers'.
4. Ensure 'instruction_steps' contains at least 3-8 clear, chronological procedure steps.
5. In 'full_content', provide the complete document content formatted neatly with Markdown headings (##, ###), bullet points, and callouts.`;

  try {
    logger.info("Calling OpenAI to parse SOP document", { filename: originalFilename, chars: truncatedText.length });
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: getOpenAiModel(),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Here is the full text extracted from the uploaded document:\n\n---\n${truncatedText}\n---` },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      logger.error("OpenAI API error during SOP document parsing", { status: response.status, body: errBody });
      return heuristicParseSop(rawText, originalFilename);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return heuristicParseSop(rawText, originalFilename);
    }

    const parsed = JSON.parse(content);

    // Normalize output
    const scripts = Array.isArray(parsed.scripts) && parsed.scripts.length > 0
      ? parsed.scripts.map((s) => ({
          heading: s.heading || "Call Script",
          content: s.content || "",
        }))
      : [{ heading: "Standard Call Script", content: parsed.script || "" }];

    const script = parsed.script || scripts.map((s) => `[${s.heading}]\n${s.content}`).join("\n\n");

    const instructionSteps = Array.isArray(parsed.instruction_steps) && parsed.instruction_steps.length > 0
      ? parsed.instruction_steps.map((st, i) => ({
          step: st.step || i + 1,
          title: typeof st === "string" ? st : (st.title || st.text || `Step ${i + 1}`),
        }))
      : [{ step: 1, title: "Review lead requirements and initiate SOP procedure" }];

    const questions = Array.isArray(parsed.questions) && parsed.questions.length > 0
      ? parsed.questions.map((q) => (typeof q === "string" ? q : (q.question || q.text || String(q))))
      : [];

    const questionsAnswers = Array.isArray(parsed.questions_answers) ? parsed.questions_answers : [];

    // If Q&A pairs exist, also make sure all questions are in questions array
    questionsAnswers.forEach((qa) => {
      if (qa.question && !questions.includes(qa.question)) {
        questions.push(qa.question);
      }
    });

    return {
      title: parsed.title || originalFilename || "Standard Operating Procedure",
      description: parsed.description || "Standard operating procedure detailing execution steps and protocols.",
      category: parsed.category || "Sales Call",
      status: "Draft",
      priority: parsed.priority || "Medium",
      department: parsed.department || "Sales Operations",
      estimated_time: parsed.estimated_time || "20 min",
      scripts,
      script,
      questions,
      questions_answers: questionsAnswers,
      frameworks: Array.isArray(parsed.frameworks) ? parsed.frameworks : [],
      instruction_steps: instructionSteps,
      tags: Array.isArray(parsed.tags) ? parsed.tags : ["SOP", "Playbook"],
      services: Array.isArray(parsed.services) && parsed.services.length ? parsed.services : ["All Services"],
      full_content: parsed.full_content || rawText,
    };
  } catch (err) {
    logger.error("Error parsing SOP with OpenAI, using heuristic fallback", { error: err.message });
    return heuristicParseSop(rawText, originalFilename);
  }
}

/**
 * Generate full custom SOP from Title using OpenAI
 */
async function generateSopFromTitle(title, customPrompt = "", category = "Sales Call", service = "All Services") {
  const apiKey = getOpenAiKey();

  if (!apiKey || !title || !title.trim()) {
    return heuristicParseSop(title, title);
  }

  const systemPrompt = `You are a world-class Sales Operations, CRM, and SOP AI Architect.
The user wants to generate a complete, production-ready Standard Operating Procedure (SOP) based on the title: "${title}".
Category: ${category} | Service: ${service}

Generate a hyper-relevant, comprehensive SOP specifically tailored to this title.
Include realistic dialogue scripts (with multiple stages: Opening Hook, Value Pitch, Objection Handling, Closing), qualification & discovery questions, objection resolution Q&A, actionable step-by-step procedures, and relevant frameworks.

Respond ONLY with a valid JSON object matching this schema:
{
  "title": "${title}",
  "description": "Comprehensive summary and scope of this SOP",
  "category": "Sales Call" | "After Call" | "During Meeting" | "After Meeting" | "After Closing",
  "priority": "Critical" | "High" | "Medium" | "Low",
  "department": "Department (e.g. Sales, Publishing, Client Success)",
  "estimated_time": "Estimated duration (e.g. '25 min')",
  "scripts": [
    {
      "heading": "Stage heading (e.g. '1. Opening & Greeting', '2. Value Proposition', '3. Handling Budget/Timing Objections', '4. Closing & Next Step')",
      "content": "Real, professional dialogue script between Agent and Client"
    }
  ],
  "script": "Consolidated script",
  "questions": [
    "Targeted qualification and discovery questions for this SOP"
  ],
  "questions_answers": [
    {
      "question": "Common client objection or FAQ",
      "answer": "Effective agent rebuttal or recommended response guideline"
    }
  ],
  "frameworks": ["Frameworks (e.g. BANT, MEDDIC, SPIN, Launch Cadence)"],
  "instruction_steps": [
    { "step": 1, "title": "Step 1 actionable procedure" },
    { "step": 2, "title": "Step 2 actionable procedure" },
    { "step": 3, "title": "Step 3 actionable procedure" },
    { "step": 4, "title": "Step 4 actionable procedure" }
  ],
  "tags": ["relevant", "keywords"],
  "services": ["${service}"]
}`;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: getOpenAiModel(),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Please generate the complete SOP for: "${title}". ${customPrompt || ""}` },
        ],
        temperature: 0.4,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      return heuristicParseSop(title, title);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return heuristicParseSop(title, title);

    const parsed = JSON.parse(content);
    return {
      title: parsed.title || title,
      description: parsed.description || `Standard operating procedure for ${title}.`,
      category: parsed.category || category || "Sales Call",
      status: "Draft",
      priority: parsed.priority || "Medium",
      department: parsed.department || "Sales Operations",
      estimated_time: parsed.estimated_time || "20 min",
      scripts: Array.isArray(parsed.scripts) && parsed.scripts.length > 0 ? parsed.scripts : [{ heading: "Standard Call Script", content: parsed.script || "" }],
      script: parsed.script || "",
      questions: Array.isArray(parsed.questions) ? parsed.questions : [],
      questions_answers: Array.isArray(parsed.questions_answers) ? parsed.questions_answers : [],
      frameworks: Array.isArray(parsed.frameworks) ? parsed.frameworks : [],
      instruction_steps: Array.isArray(parsed.instruction_steps) ? parsed.instruction_steps : [{ step: 1, title: "Execute procedure steps" }],
      tags: Array.isArray(parsed.tags) ? parsed.tags : ["SOP"],
      services: Array.isArray(parsed.services) ? parsed.services : [service || "All Services"],
    };
  } catch (err) {
    logger.error("Error generating SOP from title with OpenAI", { error: err.message });
    return heuristicParseSop(title, title);
  }
}

module.exports = {
  extractTextFromDocument,
  heuristicParseSop,
  parseSopDocumentWithAi,
  generateSopFromTitle,
};
