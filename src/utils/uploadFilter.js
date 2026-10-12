/**
 * E-06: uploads used to accept ANY file type (an .html / .svg / .exe could be stored and served from /uploads).
 * Only documents, spreadsheets, images, audio / video and plain text are accepted.
 */
const path = require("path");

const ALLOWED_EXTENSIONS = new Set([
  ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic",
  ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".csv", ".txt",
  ".mp3", ".wav", ".m4a", ".ogg", ".mp4", ".mov", ".webm",
]);
// Types a browser would RUN if it were opened from our domain.
const BLOCKED_MIME = /^(text\/html|image\/svg\+xml|application\/(x-)?(javascript|ecmascript|xhtml\+xml|x-sh|x-msdownload|x-executable)|text\/javascript)/i;

function isAllowedUpload(file) {
  if (!file) return false;
  const ext = path.extname(String(file.originalname || "")).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) return false;
  if (BLOCKED_MIME.test(String(file.mimetype || ""))) return false;
  return true;
}

function uploadFileFilter(req, file, cb) {
  if (isAllowedUpload(file)) return cb(null, true);
  const err = new Error("This file type is not allowed. Upload a PDF, image, document, spreadsheet, audio or video file.");
  err.status = 400;
  return cb(err);
}

module.exports = { isAllowedUpload, uploadFileFilter, ALLOWED_EXTENSIONS };
