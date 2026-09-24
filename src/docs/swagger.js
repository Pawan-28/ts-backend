const swaggerUi = require("swagger-ui-express");

const openApiSpec = {
  openapi: "3.0.0",
  info: {
    title: "TS Publication CRM Operational API",
    version: "1.0.0",
    description: "Lead queue, assignment, employee workflow, timeline, analytics, notifications, and webhook APIs. Backed by MySQL.",
  },
  servers: [{ url: "/api/v1" }],
  tags: [
    { name: "Leads" },
    { name: "Assignment" },
    { name: "Employees" },
    { name: "Employee Workflow" },
    { name: "Analytics" },
    { name: "Notifications" },
    { name: "Activity" },
    { name: "Webhooks" },
  ],
  paths: {
    "/leads": {
      get: { tags: ["Leads"], summary: "List leads with assignment, source, stage, and search filters" },
      post: { tags: ["Leads"], summary: "Create lead, enqueue for assignment, optionally auto-assign" },
    },
    "/leads-queue": {
      get: { tags: ["Assignment"], summary: "List lead assignment queue items" },
    },
    "/assignment/assign": {
      post: { tags: ["Assignment"], summary: "Manually assign one lead to an employee" },
    },
    "/assignment/bulk-assign": {
      post: { tags: ["Assignment"], summary: "Bulk assign or bulk reassign leads" },
    },
    "/assignment/run-round-robin": {
      post: { tags: ["Assignment"], summary: "Process queued leads through round-robin or workload engine" },
    },
    "/employees": {
      get: { tags: ["Employees"], summary: "List employees and capacity state" },
      post: { tags: ["Employees"], summary: "Create employee" },
    },
    "/employee/{employeeId}/dashboard": {
      get: { tags: ["Employee Workflow"], summary: "Employee dashboard payload: leads, tasks, followups, calls" },
    },
    "/employee/calls": {
      post: { tags: ["Employee Workflow"], summary: "Record call outcome and write lead timeline" },
    },
    "/employee/followups": {
      post: { tags: ["Employee Workflow"], summary: "Schedule follow-up and create linked task" },
    },
    "/employee/meetings": {
      post: { tags: ["Employee Workflow"], summary: "Schedule meeting" },
    },
    "/analytics/admin/kpis": {
      get: { tags: ["Analytics"], summary: "Admin dashboard KPI aggregation" },
    },
    "/analytics/pipeline": {
      get: { tags: ["Analytics"], summary: "Pipeline group aggregation" },
    },
    "/notifications": {
      get: { tags: ["Notifications"], summary: "List notifications" },
    },
    "/activity/timeline": {
      get: { tags: ["Activity"], summary: "Global or lead-specific timeline feed" },
    },
    "/webhooks/n8n": {
      post: { tags: ["Webhooks"], summary: "Receive n8n lead payload and enqueue" },
    },
    "/webhooks/forms/{formId}/submit": {
      post: { tags: ["Webhooks"], summary: "Receive website/form lead payload and enqueue" },
    },
  },
};

function mountSwagger(app) {
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openApiSpec));
  app.get("/api/openapi.json", (req, res) => res.json(openApiSpec));
}

module.exports = { mountSwagger, openApiSpec };
