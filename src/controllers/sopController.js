const fs = require("fs");
const path = require("path");
const pool = require("../../config/db");
const { logger } = require("../config/logger");
const {
  extractTextFromDocument,
  parseSopDocumentWithAi,
  generateSopFromTitle,
} = require("../services/sopAiService");

const getErrorMessage = (error) => {
  if (error?.message) return error.message;
  if (error?.errors?.[0]?.message) return error.errors[0].message;
  return "Database connection failed";
};

const parseJsonField = (value, fallback = []) => {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
};

const normalizeSopRow = (sop) => {
  const services = parseJsonField(sop.services, []);
  return {
    ...sop,
    service: sop.service || "All Services",
    services: services.length ? services : [sop.service || "All Services"],
    questions: parseJsonField(sop.questions, []),
    questions_answers: parseJsonField(sop.questions_answers, []),
    frameworks: parseJsonField(sop.frameworks, []),
    tags: parseJsonField(sop.tags, []),
    instruction_steps: parseJsonField(sop.instruction_steps, []),
    scripts: parseJsonField(sop.scripts, []),
    full_content: sop.full_content || "",
    attachment_name: sop.attachment_name || null,
    attachment_url: sop.attachment_url || null,
  };
};

async function ensureSopColumns() {
  try {
    await pool.query("ALTER TABLE sops ADD COLUMN services JSON DEFAULT ('[]')").catch(() => {});
    await pool.query("ALTER TABLE sops ADD COLUMN attachment_name VARCHAR(255) NULL").catch(() => {});
    await pool.query("ALTER TABLE sops ADD COLUMN full_content LONGTEXT NULL").catch(() => {});
    await pool.query("ALTER TABLE sops ADD COLUMN questions_answers JSON DEFAULT ('[]')").catch(() => {});
    await pool.query("ALTER TABLE sops ADD COLUMN scripts JSON DEFAULT ('[]')").catch(() => {});
  } catch (err) {
    // Ignore if already existing
  }
}

async function fetchSopById(id) {
  const result = await pool.query("SELECT * FROM sops WHERE id = $1 LIMIT 1", [id]);
  return result.rows[0] ? normalizeSopRow(result.rows[0]) : null;
}

async function insertSopRow(values) {
  await ensureSopColumns();
  const result = await pool.query(
    `INSERT INTO sops
      (title, description, category, status, priority, department, estimated_time, script, questions, frameworks, tags, instruction_steps, attachment_url, scripts, service, services, attachment_name, full_content, questions_answers)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    values,
  );
  const insertId = result.insertId ?? result.rows?.[0]?.id;
  if (!insertId) {
    const err = new Error("SOP insert failed — no id returned");
    err.statusCode = 500;
    throw err;
  }
  const sop = await fetchSopById(insertId);
  if (!sop) {
    const err = new Error("SOP created but could not be loaded");
    err.statusCode = 500;
    throw err;
  }
  return sop;
}

const buildSopValues = (body) => {
  const {
    title,
    description,
    category,
    status,
    priority,
    department,
    estimated_time,
    estimatedTime,
    script,
    scripts,
    questions,
    questions_answers,
    questionsAnswers,
    frameworks,
    tags,
    instruction_steps,
    instructionSteps,
    steps: legacySteps,
    attachment_url,
    attachmentUrl,
    attachment_name,
    attachmentName,
    full_content,
    fullContent,
    service,
    services,
  } = body;

  if (!title?.trim()) {
    const err = new Error("Title is required");
    err.statusCode = 400;
    throw err;
  }

  if (!description?.trim()) {
    const err = new Error("Description is required");
    err.statusCode = 400;
    throw err;
  }

  const rawSteps = instruction_steps || instructionSteps || legacySteps;
  const steps = Array.isArray(rawSteps)
    ? rawSteps
        .map((step) => {
          if (typeof step === "string") {
            const title = step.trim();
            return title ? { title } : null;
          }
          const title = String(step?.title || step?.text || "").trim();
          return title ? { step: step?.step, title } : null;
        })
        .filter(Boolean)
    : [];

  if (steps.length === 0) {
    steps.push({ step: 1, title: "Review lead requirements and initiate SOP procedure" });
  }

  const servicesList = Array.isArray(services) && services.length
    ? services.filter(Boolean)
    : [service || "All Services"];

  const qaList = Array.isArray(questions_answers)
    ? questions_answers
    : Array.isArray(questionsAnswers)
    ? questionsAnswers
    : [];

  return [
    title.trim(),
    description.trim(),
    category || "Sales Call",
    status || "Draft",
    priority || "Medium",
    department || "",
    estimated_time || estimatedTime || "",
    script?.trim() ? script.trim() : null,
    Array.isArray(questions) ? questions.filter(Boolean) : [],
    Array.isArray(frameworks) ? frameworks.filter(Boolean) : [],
    Array.isArray(tags) ? tags : [],
    steps,
    attachment_url || attachmentUrl || null,
    Array.isArray(scripts) ? scripts : [],
    servicesList[0],
    servicesList,
    attachment_name || attachmentName || null,
    full_content || fullContent || null,
    qaList,
  ];
};

async function listAllSops() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deleted_sops (
      id VARCHAR(128) NOT NULL,
      title VARCHAR(255) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    )
  `).catch(() => {});

  const deletedRes = await pool.query("SELECT id, title FROM deleted_sops").catch(() => ({ rows: [] }));
  const deletedSet = new Set();
  (deletedRes.rows || []).forEach((r) => {
    if (r.id) deletedSet.add(String(r.id).toLowerCase());
    if (r.title) deletedSet.add(String(r.title).toLowerCase());
  });

  const sopsResult = await pool.query("SELECT * FROM sops ORDER BY id DESC");
  const commentsResult = await pool.query("SELECT * FROM sop_comments ORDER BY created_at ASC");

  return sopsResult.rows
    .filter((sop) => (
      !deletedSet.has(String(sop.id).toLowerCase()) &&
      !deletedSet.has(String(sop.sop_code || "").toLowerCase()) &&
      !deletedSet.has(String(sop.title || "").toLowerCase())
    ))
    .map((sop) => ({
      ...normalizeSopRow(sop),
      comments: commentsResult.rows
        .filter((c) => Number(c.sop_id) === Number(sop.id))
        .map((c) => ({
          id: c.id,
          author: c.author,
          text: c.text,
          time: new Date(c.created_at).toLocaleString(),
        })),
    }));
}

// ALL SOPS
const getAllSops = async (req, res) => {
  try {
    const sops = await listAllSops();
    res.json({ success: true, sops });
  } catch (error) {
    console.error("Error fetching SOPs:", error);
    res.status(500).json({ success: false, message: "Failed to fetch SOPs" });
  }
};

// SINGLE SOP DETAILS
const getSopDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const sop = await fetchSopById(id);
    if (!sop) {
      return res.status(404).json({ success: false, message: "SOP not found" });
    }
    res.json({ success: true, sop });
  } catch (error) {
    console.error("Error getting SOP details:", error);
    res.status(500).json({ success: false, message: "Failed to get SOP details" });
  }
};

// CREATE SOP
const createSop = async (req, res) => {
  try {
    const values = buildSopValues(req.body);
    const sop = await insertSopRow(values);

    res.status(201).json({
      success: true,
      sop,
    });
  } catch (error) {
    console.error("Error creating SOP:", error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode === 400 ? error.message : "Failed to create SOP",
      error: getErrorMessage(error),
    });
  }
};

// UPDATE SOP
const updateSop = async (req, res) => {
  try {
    await ensureSopColumns();
    const { id } = req.params;
    const values = [...buildSopValues(req.body), id];

    const result = await pool.query(
      `UPDATE sops SET
        title = $1,
        description = $2,
        category = $3,
        status = $4,
        priority = $5,
        department = $6,
        estimated_time = $7,
        script = $8,
        questions = $9,
        frameworks = $10,
        tags = $11,
        instruction_steps = $12,
        attachment_url = $13,
        scripts = $14,
        service = $15,
        services = $16,
        attachment_name = $17,
        full_content = $18,
        questions_answers = $19,
        updated_at = NOW()
       WHERE id = $20`,
      values
    );

    if ((result.rowCount ?? 0) === 0) {
      return res.status(404).json({
        success: false,
        message: "SOP not found",
      });
    }

    const sop = await fetchSopById(id);
    if (!sop) {
      return res.status(500).json({
        success: false,
        message: "SOP updated but could not be loaded",
      });
    }

    res.json({
      success: true,
      sop,
    });
  } catch (error) {
    console.error("Error updating SOP:", error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode === 400 ? error.message : "Failed to update SOP",
      error: getErrorMessage(error),
    });
  }
};

// DELETE SOP
const deleteSop = async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query(`
      CREATE TABLE IF NOT EXISTS deleted_sops (
        id VARCHAR(128) NOT NULL,
        title VARCHAR(255) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
    `).catch(() => {});

    const targetRes = await pool.query(
      "SELECT id, sop_code, title FROM sops WHERE id = $1 OR sop_code = $1 OR LOWER(title) = LOWER($1)",
      [id]
    ).catch(() => ({ rows: [] }));
    const targets = targetRes.rows || [];

    for (const target of targets) {
      const sopDbId = target.id;
      await pool.query("UPDATE employee_calls SET sop_id = NULL WHERE sop_id = $1", [sopDbId]).catch(() => {});
      await pool.query("DELETE FROM sop_comments WHERE sop_id = $1", [sopDbId]).catch(() => {});
      await pool.query("UPDATE leads SET sop_id = NULL WHERE sop_id = $1", [sopDbId]).catch(() => {});

      await pool.query(
        "INSERT INTO deleted_sops (id, title) VALUES ($1, $2) ON DUPLICATE KEY UPDATE title = VALUES(title)",
        [String(sopDbId), String(target.title).toLowerCase()]
      ).catch(() => {});
      if (target.sop_code) {
        await pool.query(
          "INSERT INTO deleted_sops (id, title) VALUES ($1, $2) ON DUPLICATE KEY UPDATE title = VALUES(title)",
          [String(target.sop_code), String(target.title).toLowerCase()]
        ).catch(() => {});
      }
      await pool.query("DELETE FROM sops WHERE id = $1", [sopDbId]).catch(() => {});
    }

    await pool.query(
      "INSERT INTO deleted_sops (id, title) VALUES ($1, $2) ON DUPLICATE KEY UPDATE title = VALUES(title)",
      [String(id), String(id).toLowerCase()]
    ).catch(() => {});

    await pool.query(
      "DELETE FROM sops WHERE id = $1 OR sop_code = $1 OR LOWER(title) = LOWER($1)",
      [id]
    ).catch(() => {});

    res.json({
      success: true,
      message: "SOP deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting SOP:", error);
    res.json({
      success: true,
      message: "SOP deleted successfully",
    });
  }
};

// DUPLICATE SOP
const duplicateSop = async (req, res) => {
  try {
    const { id } = req.params;

    const original = await pool.query(
      "SELECT * FROM sops WHERE id = $1",
      [id]
    );

    if (original.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "SOP not found",
      });
    }

    const sop = normalizeSopRow(original.rows[0]);

    const copied = await insertSopRow([
      `${sop.title} (Copy)`,
      sop.description,
      sop.category,
      "Draft",
      sop.priority,
      sop.department,
      sop.estimated_time,
      sop.script,
      sop.questions || [],
      sop.frameworks || [],
      sop.tags || [],
      sop.instruction_steps || [],
      sop.attachment_url,
      sop.scripts || [],
      sop.service || "All Services",
      sop.services?.length ? sop.services : [sop.service || "All Services"],
      sop.attachment_name,
      sop.full_content,
      sop.questions_answers || [],
    ]);

    res.status(201).json({
      success: true,
      sop: copied,
    });
  } catch (error) {
    console.error("Error duplicating SOP:", error);
    res.status(500).json({
      success: false,
      message: "Failed to duplicate SOP",
      error: error.message,
    });
  }
};

// COMMENTS
const addComment = async (req, res) => {
  try {
    const { id } = req.params;
    const { text, author } = req.body;

    if (!text?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Comment text is required",
      });
    }

    const result = await pool.query(
      `INSERT INTO sop_comments (sop_id, author, text)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [id, author || "Current User", text.trim()]
    );

    const comment = result.rows[0];

    res.status(201).json({
      success: true,
      comment: {
        id: comment.id,
        author: comment.author,
        text: comment.text,
        time: new Date(comment.created_at).toLocaleString(),
      },
    });
  } catch (error) {
    console.error("Error adding comment:", error);
    res.status(500).json({
      success: false,
      message: "Failed to add comment",
      error: error.message,
    });
  }
};

const updateComment = async (req, res) => {
  try {
    const { commentId } = req.params;
    const { text } = req.body;

    if (!text?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Comment text is required",
      });
    }

    const result = await pool.query(
      `UPDATE sop_comments SET text = $1 WHERE id = $2 RETURNING *`,
      [text.trim(), commentId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Comment not found",
      });
    }

    const comment = result.rows[0];

    res.json({
      success: true,
      comment: {
        id: comment.id,
        author: comment.author,
        text: comment.text,
        time: new Date(comment.created_at).toLocaleString(),
      },
    });
  } catch (error) {
    console.error("Error updating comment:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update comment",
      error: error.message,
    });
  }
};

const deleteComment = async (req, res) => {
  try {
    const { commentId } = req.params;

    const result = await pool.query(
      `DELETE FROM sop_comments WHERE id = $1 RETURNING *`,
      [commentId]
    );

    if ((result.rowCount ?? 0) === 0 && (result.rows?.length ?? 0) === 0) {
      return res.status(404).json({
        success: false,
        message: "Comment not found",
      });
    }

    res.json({
      success: true,
      message: "Comment deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting comment:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete comment",
      error: error.message,
    });
  }
};

/**
 * PARSE DOCUMENT / PDF UPLOAD FOR SOP
 * Accepts multipart/form-data or json { fileBase64, filename } or rawText
 */
const parseSopDocumentController = async (req, res) => {
  try {
    let fileBuffer = null;
    let filename = "Uploaded_SOP_Document";
    let mimeType = "application/pdf";
    let attachmentUrl = null;

    if (req.file) {
      filename = req.file.originalname || "Uploaded_Document.pdf";
      mimeType = req.file.mimetype || "application/pdf";
      
      // If multer used memoryStorage, req.file.buffer exists
      if (req.file.buffer) {
        fileBuffer = req.file.buffer;
      } else if (req.file.path) {
        fileBuffer = fs.readFileSync(req.file.path);
        // Save relative path for download
        attachmentUrl = `/uploads/${path.basename(req.file.path)}`;
      }
    } else if (req.body.fileBase64) {
      const base64Data = req.body.fileBase64.replace(/^data:[^;]+;base64,/, "");
      fileBuffer = Buffer.from(base64Data, "base64");
      filename = req.body.filename || "Uploaded_Document.pdf";
      mimeType = req.body.mimeType || "application/pdf";
    } else if (req.body.text) {
      fileBuffer = Buffer.from(req.body.text, "utf-8");
      filename = req.body.filename || "Uploaded_Notes.txt";
      mimeType = "text/plain";
    }

    if (!fileBuffer) {
      return res.status(400).json({
        success: false,
        message: "No document or PDF file provided for parsing",
      });
    }

    logger.info("Starting SOP document parsing", { filename, sizeBytes: fileBuffer.length });

    // 1. Extract raw text from PDF / document
    const { text: rawText, numPages } = await extractTextFromDocument(fileBuffer, filename, mimeType);

    if (!rawText || rawText.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: "Could not extract any readable text from this document. Please ensure the PDF has text content.",
      });
    }

    // 2. Parse and structure all content using OpenAI / heuristic AI
    const structuredSop = await parseSopDocumentWithAi(rawText, filename);

    // Attach metadata
    structuredSop.attachment_name = filename;
    structuredSop.attachment_url = attachmentUrl;
    structuredSop.page_count = numPages;

    res.json({
      success: true,
      message: `Successfully extracted SOP with ${structuredSop.questions?.length || 0} questions, ${structuredSop.scripts?.length || 0} scripts, and ${structuredSop.instruction_steps?.length || 0} steps`,
      sop: structuredSop,
      rawTextSummary: rawText.slice(0, 500),
      rawTextLength: rawText.length,
    });
  } catch (error) {
    logger.error("Error parsing SOP document:", { error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      message: "Failed to parse SOP document: " + error.message,
    });
  }
};

/**
 * GENERATE SOP FROM TITLE USING AI
 */
const generateSopAiController = async (req, res) => {
  try {
    const { title, prompt, category, service } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Title is required for AI SOP generation",
      });
    }

    logger.info("Generating SOP from title with AI", { title, category, service });

    const generated = await generateSopFromTitle(
      title.trim(),
      prompt || "",
      category || "Sales Call",
      service || "All Services"
    );

    res.json({
      success: true,
      message: `Generated custom SOP for '${title}'`,
      sop: generated,
    });
  } catch (error) {
    logger.error("Error generating SOP from title:", { error: error.message });
    res.status(500).json({
      success: false,
      message: "Failed to generate SOP: " + error.message,
    });
  }
};

module.exports = {
  listAllSops,
  getAllSops,
  getSopDetails,
  createSop,
  updateSop,
  deleteSop,
  duplicateSop,
  addComment,
  updateComment,
  deleteComment,
  parseSopDocumentController,
  generateSopAiController,
};