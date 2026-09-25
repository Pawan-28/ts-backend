const express = require("express");
const cors = require("cors");
const path = require("path");

const authRoutes = require("./routes/authRoutes");
const { authenticate } = require("./middleware/auth");

const dashboardRoutes = require("./routes/dashboardRoutes");
const sopRoutes = require("./routes/soprouter");
const salesRoutes = require("./routes/salesrouter");
const reportsRoutes = require("./routes/reportsRoutes");
const incentivesRoutes = require("./routes/incentivesrouter");
const teamRoutes = require("./routes/teamRoutes");
const settingsRoutes = require("./routes/settingsRoutes");
const activityRoutes = require("./routes/activityRoutes");
const operationalRoutes = require("./routes/operationalRoutes");
const googleRoutes = require("./routes/googleRoutes");
const servicesRoutes = require("./routes/servicesRoutes");
const formsRoutes = require("./routes/formsRoutes");
const aiRoutes = require("./routes/aiRoutes");
const { mountSwagger } = require("./docs/swagger");
const { logger } = require("./config/logger");
const { isPgReady } = require("./middleware/pgReady");
const app = express();

const DEFAULT_FRONTEND_ORIGINS = [
  "https://ts-frontend-two.vercel.app",
  "http://localhost:5173",
  "http://localhost:8080",
];

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (DEFAULT_FRONTEND_ORIGINS.includes(origin)) return true;
  if (/^https:\/\/[\w-]+\.vercel\.app$/i.test(origin)) return true;
  if (/^http:\/\/localhost:\d+$/i.test(origin)) return true;
  // Phone/tablet hitting the dev machine's LAN address during local testing.
  if (/^http:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)[\d.]+:\d+$/i.test(origin)) return true;
  const extra = process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  return extra.includes(origin);
}

app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      callback(null, origin || true);
    } else {
      callback(null, false);
    }
  },
  credentials: true,
}));
app.use(express.json());
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "ts-publications-crm-api",
    auth: true,
    database: isPgReady() ? "connected" : "disconnected",
    timestamp: new Date().toISOString(),
  });
});

app.get("/", (req, res) => {
  res.json({
    message: "Backend is running successfully",
    auth: true,
    authLogin: "/api/auth/login",
    health: "/health",
    operationalApi: "/api/v1",
    n8nWebhook: "/api/v1/webhooks/n8n",
    callyzerWebhook: "/api/v1/webhooks/callyzer",
    docs: "/api/docs",
    database: isPgReady() ? "connected" : "disconnected",
  });
});

app.use("/api/auth", authRoutes);
app.use(authenticate);

app.use("/api/dashboard", dashboardRoutes);
app.use("/api/sop", sopRoutes);
app.use("/api/v1/sops", sopRoutes);
app.use("/api/sales", salesRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/incentives", incentivesRoutes);
app.use("/api/team", teamRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/activity", activityRoutes);
app.use("/api/services", servicesRoutes);
app.use("/api/forms", formsRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/v1/ai", aiRoutes);
app.use("/api/v1", googleRoutes);
app.use("/api/v1", operationalRoutes);
mountSwagger(app);

app.use((err, req, res, next) => {
  logger.error(err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal server error",
  });
});

app.isAllowedOrigin = isAllowedOrigin;

module.exports = app;