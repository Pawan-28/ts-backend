const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const router = express.Router();

const {
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
} = require("../controllers/sopController");

const uploadDir = path.join(process.cwd(), "uploads", "sops");
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const cleanName = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, "_");
    const unique = `${cleanName}-${Date.now()}${ext}`;
    cb(null, unique);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB
});

// GET ALL SOPS
router.get("/all", getAllSops);

// GET SINGLE SOP DETAILS
router.get("/details/:id", getSopDetails);
router.get("/:id", getSopDetails);

// AI PARSE DOCUMENT / PDF UPLOAD
router.post("/parse-document", upload.single("file"), parseSopDocumentController);
router.post("/parse-pdf", upload.single("file"), parseSopDocumentController);

// AI GENERATE FROM TITLE
router.post("/generate-ai", generateSopAiController);

// CREATE SOP
router.post("/create", createSop);

// UPDATE SOP
router.put("/update/:id", updateSop);
router.put("/:id", updateSop);

// DELETE SOP
router.delete("/delete/:id", deleteSop);
router.delete("/:id", deleteSop);

// DUPLICATE SOP
router.post("/duplicate/:id", duplicateSop);

// COMMENTS
router.post("/:id/comment", addComment);
router.put("/:sopId/comment/:commentId", updateComment);
router.delete("/:sopId/comment/:commentId", deleteComment);

module.exports = router;