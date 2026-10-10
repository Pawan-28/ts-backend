// Run: node --test src/utils/conversationStage.test.js
// An answered call above 2 minutes = Conversation, on EVERY lead row of that phone, whoever made the call - for new calls (live rule)
// and for old data (one-time script).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { stageForCall } = require("../services/autoPipelineStageService");

const read = (rel) => fs.readFileSync(path.join(__dirname, "../..", rel), "utf8");

test("which stage a single call implies (same definitions as the Pipeline): 120 s is Short, 121 s is Conversation, any direction", () => {
  assert.equal(stageForCall({ direction: "outbound", outcome: "Connected", durationSec: 121 }), "conversation_2min");
  assert.equal(stageForCall({ direction: "inbound", outcome: "Connected", durationSec: 600 }), "conversation_2min");
  assert.equal(stageForCall({ direction: "outbound", outcome: "Connected", durationSec: 120 }), "short_call");
  assert.equal(stageForCall({ direction: "inbound", outcome: "Connected", durationSec: 30 }), "short_call");
  assert.equal(stageForCall({ direction: "outbound", outcome: "Not Answered", durationSec: 0 }), "not_pick");
});

test("live rule: the call moves its own lead AND every other lead row of the same phone; forward only, early funnel only", () => {
  const s = read("src/services/autoPipelineStageService.js");
  assert.match(s, /async function siblingLeadIds\(tenantId, leadId, phone\)/);
  assert.match(s, /RIGHT\(REGEXP_REPLACE\(COALESCE\(phone, ''\), '\[\^0-9\]', ''\), 10\) = \$3/, "same last-10-digit phone key as the Pipeline");
  assert.match(s, /for \(const id of await siblingLeadIds\(tenantId, leadId, lead\?\.phone\)\)/);
  assert.match(s, /if \(!\(currentId in EARLY_RANK\)\) return \{ changed: false \};/, "Meeting Booked and later are never overwritten");
  assert.match(s, /if \(EARLY_RANK\[target\] <= EARLY_RANK\[currentId\]\) return \{ changed: false \};/, "forward only");
  assert.match(s, /never breaks|Never break call sync/i);
});

test("a manually logged call moves the person through the pipeline like a synced one", () => {
  const r = read("src/routes/operationalRoutes.js");
  assert.match(r, /autoPipelineStageService"\)\.applyCallToLeadStage\(\{\s*tenantId,\s*leadId: lead\.id,/);
});

test("old data: a one-time script that is a DRY RUN unless --apply, backs up first and can undo", () => {
  const s = read("scripts/backfill-conversation-stage.js");
  assert.match(s, /const APPLY = process\.argv\.includes\("--apply"\)/);
  assert.match(s, /if \(!APPLY\) \{[\s\S]*?process\.exit\(0\);/);
  assert.ok(s.indexOf("fs.writeFileSync(file") < s.indexOf("repo.updateLead(TENANT"), "the backup CSV is written BEFORE any update");
  assert.match(s, /const BEHIND = new Set\(\["lead", "not_pick", "short_call"\]\);/, "only Lead / Not Pick / Short Call move");
  assert.match(s, /--restore/);
  assert.match(s, /Meeting Booked and later stages, Not Interested and every deleted lead are never touched/);
});
