const express = require("express");
const router = express.Router();
const { listForms, createForm, updateForm } = require("../controllers/formsController");

router.get("/", listForms);
router.post("/", createForm);
router.put("/:id", updateForm);

module.exports = router;
