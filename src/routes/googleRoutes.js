const express = require("express");
const { requireEmployee } = require("../middleware/auth");
const {
  googleConnectUrl,
  googleStatus,
  googleDisconnect,
  generateMeetLink,
} = require("../controllers/googleController");

const router = express.Router();

router.get("/employee/google/status", requireEmployee, googleStatus);
router.get("/employee/google/connect-url", requireEmployee, googleConnectUrl);
router.delete("/employee/google/disconnect", requireEmployee, googleDisconnect);
router.post("/employee/meetings/generate-meet-link", requireEmployee, generateMeetLink);

module.exports = router;
