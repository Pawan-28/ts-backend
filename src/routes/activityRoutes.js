const express = require("express");
const router  = express.Router();
const {
  getRecentActivity,
  getNotifications,
  markAllRead,
  globalSearch,
} = require("../controllers/activityController");

// correct — no /activity prefix since app.js already adds it
router.get("/",                getRecentActivity);   // → /api/activity
router.get("/notifications",   getNotifications);    // → /api/activity/notifications
router.post("/notifications/read", markAllRead);     // → /api/activity/notifications/read
router.get("/search",          globalSearch);        // → /api/activity/search

module.exports = router;