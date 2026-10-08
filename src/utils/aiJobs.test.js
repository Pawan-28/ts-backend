// Run: node --test src/utils/aiJobs.test.js
// Long AI MoM (47-minute call) runs as a background job: the request returns at once, the page polls, one job per call.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createJobRunner } = require("./aiJobs");

const tick = () => new Promise((r) => setImmediate(r));

test("start returns immediately as running; the result appears when the work finishes", async () => {
  const jobs = createJobRunner();
  let release;
  const gate = new Promise((r) => { release = r; });
  const { started, job } = jobs.start("t:1", () => gate.then(() => ({ id: 1, ai_summary: "MoM" })));
  assert.equal(started, true);
  assert.equal(job.state, "running");
  assert.equal(jobs.get("t:1").state, "running");
  release();
  await tick();
  const done = jobs.get("t:1");
  assert.equal(done.state, "done");
  assert.deepEqual(done.result, { id: 1, ai_summary: "MoM" });
  assert.ok(done.finishedAt >= done.startedAt);
});

test("asking again while it runs joins the SAME job - no second run, no second Gemini spend", async () => {
  const jobs = createJobRunner();
  let runs = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const work = () => { runs += 1; return gate; };
  assert.equal(jobs.start("t:1", work).started, true);
  assert.equal(jobs.start("t:1", work).started, false);
  assert.equal(jobs.start("t:1", work).started, false);
  release();
  await tick();
  assert.equal(runs, 1);
});

test("a different call is its own job", async () => {
  const jobs = createJobRunner();
  let release;
  const gate = new Promise((r) => { release = r; });
  assert.equal(jobs.start("t:1", () => gate).started, true);
  assert.equal(jobs.start("t:2", () => gate).started, true);
  release();
  await tick();
});

test("a failure is kept with its message and status; the same call can be started again afterwards", async () => {
  const jobs = createJobRunner();
  jobs.start("t:1", async () => { const e = new Error("Call log not found"); e.status = 404; throw e; });
  await tick();
  const failed = jobs.get("t:1");
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.error, { message: "Call log not found", status: 404 });
  const again = jobs.start("t:1", async () => ({ id: 1 }));
  assert.equal(again.started, true, "a finished job does not block a re-process");
  await tick();
  assert.equal(jobs.get("t:1").state, "done");
});

test("a synchronous throw inside the work is a failed job, not a crash", async () => {
  const jobs = createJobRunner();
  jobs.start("t:1", () => { throw new Error("boom"); });
  await tick();
  assert.equal(jobs.get("t:1").state, "failed");
  assert.equal(jobs.get("t:1").error.message, "boom");
});

test("finished jobs are dropped after the keep time; a running job never is", async () => {
  let t = 1_000;
  const jobs = createJobRunner({ ttlMs: 60_000, now: () => t });
  let release;
  const gate = new Promise((r) => { release = r; });
  jobs.start("run", () => gate);
  jobs.start("fin", async () => "ok");
  await tick();
  t += 59_000;
  assert.equal(jobs.get("fin").state, "done");
  t += 2_000;
  assert.equal(jobs.get("fin"), null, "expired");
  assert.equal(jobs.get("run").state, "running", "a long job is never dropped while it runs");
  release();
  await tick();
});

test("wiring: async request -> 202 + job, status route, controller keeps the one-request path for old callers", () => {
  const ctl = fs.readFileSync(path.join(__dirname, "../controllers/aiController.js"), "utf8");
  assert.match(ctl, /req\.body\?\.async === true \|\| req\.query\?\.async === "1"/);
  assert.match(ctl, /res\.status\(202\)\.json\(\{ success: true, status: "processing"/);
  assert.match(ctl, /const processCallStatus = /);
  assert.match(ctl, /const updatedCall = await processCallWithAi\(tenantId, callId\);/, "the old synchronous answer is still there");
  assert.match(ctl, /status: "skipped"/);
  const routes = fs.readFileSync(path.join(__dirname, "../routes/aiRoutes.js"), "utf8");
  assert.match(routes, /router\.get\("\/process-call\/:callId\/status", processCallStatus\)/);
  const svc = fs.readFileSync(path.join(__dirname, "../services/aiService.js"), "utf8");
  assert.match(svc, /i < 120; i \+= 1/, "a long recording gets ~4 min to become ready on Gemini");
});
