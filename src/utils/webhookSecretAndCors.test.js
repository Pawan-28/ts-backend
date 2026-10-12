// Run: node --test src/utils/webhookSecretAndCors.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { verifyN8nSecret } = require("./webhookSecret");

const req = (headers = {}, query = {}) => ({ headers, query });

test("n8n secret: off unless configured; exact match when configured", () => {
  delete process.env.N8N_INBOUND_SECRET;
  assert.equal(verifyN8nSecret(req()), true, "not configured = open as before");
  process.env.N8N_INBOUND_SECRET = "s3cret-value";
  assert.equal(verifyN8nSecret(req()), false);
  assert.equal(verifyN8nSecret(req({ "x-n8n-secret": "wrong" })), false);
  assert.equal(verifyN8nSecret(req({ "x-n8n-secret": "s3cret-value" })), true);
  assert.equal(verifyN8nSecret(req({ "x-webhook-secret": "s3cret-value" })), true);
  assert.equal(verifyN8nSecret(req({}, { secret: "s3cret-value" })), true);
  delete process.env.N8N_INBOUND_SECRET;
});

test("STRICT_CORS limits origins to the listed sites", () => {
  delete process.env.STRICT_CORS;
  process.env.FRONTEND_URL = "https://crm.example.com";
  const app = require("../app");
  assert.equal(app.isAllowedOrigin("https://anything-else.vercel.app"), true, "default behaviour unchanged");
  assert.equal(app.isAllowedOrigin("http://localhost:5173"), true);
  process.env.STRICT_CORS = "true";
  assert.equal(app.isAllowedOrigin("https://anything-else.vercel.app"), false);
  assert.equal(app.isAllowedOrigin("http://localhost:5173"), false);
  assert.equal(app.isAllowedOrigin("http://192.168.1.5:5173"), false);
  assert.equal(app.isAllowedOrigin("https://crm.example.com"), true);
  assert.equal(app.isAllowedOrigin("https://ts-frontend-two.vercel.app"), true, "the built-in production sites stay allowed");
  assert.equal(app.isAllowedOrigin(undefined), true, "server-to-server calls have no origin");
  delete process.env.STRICT_CORS;
  delete process.env.FRONTEND_URL;
});
