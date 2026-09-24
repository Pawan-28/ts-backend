const express = require("express");

const router = express.Router();

const {
  getSettings,
  updateSettings,
  connectGoogle,
  disconnectGoogle,
} = require("../controllers/settingsController");

router.get("/", getSettings);

router.put("/", updateSettings);

router.post("/auth/google/connect", connectGoogle);
router.post("/auth/google/disconnect", disconnectGoogle);

module.exports = router;
