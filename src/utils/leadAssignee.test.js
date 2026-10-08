// Run: node --test src/utils/leadAssignee.test.js
// A customer's booking that arrives as an UPDATE of an existing lead must still become a meeting (it was dropped with
// "meeting in payload but no assigned employee" because an un-populated lead has assignedTo = {}).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { idOf, resolveAssigneeId } = require("./leadAssignee");

const never = () => { throw new Error("must not load the lead when it already has an assignee"); };

test("idOf: populated object, bare id, empty object, nothing", () => {
  assert.equal(idOf({ id: 10, name: "Ritik" }), 10);
  assert.equal(idOf({ _id: 12 }), 12);
  assert.equal(idOf(10), 10);
  assert.equal(idOf({}), null, "the empty {} of an un-populated lead is NOT an assignee");
  assert.equal(idOf(undefined), null);
  assert.equal(idOf(null), null);
  assert.equal(idOf(""), null);
});

test("a lead that already carries its assignee is not re-read", async () => {
  assert.equal(await resolveAssigneeId({ assignedTo: { id: 10 } }, never), 10);
  assert.equal(await resolveAssigneeId({ assignedTo: 10 }, never), 10);
  assert.equal(await resolveAssigneeId({ assigned_to: 12 }, never), 12);
});

test("THE BUG: assignedTo is {} -> the real assignee is read from the populated lead", async () => {
  let loaded = 0;
  const id = await resolveAssigneeId({ id: 5484, assignedTo: {} }, async () => { loaded += 1; return { id: 5484, assignedTo: { id: 10, name: "Ritik Verma" } }; });
  assert.equal(id, 10);
  assert.equal(loaded, 1);
});

test("a lead that really has no assignee still resolves to null (the meeting is then skipped, with a log)", async () => {
  assert.equal(await resolveAssigneeId({ id: 1, assignedTo: {} }, async () => ({ id: 1, assignedTo: {} })), null);
  assert.equal(await resolveAssigneeId({ id: 1 }, async () => null), null);
  assert.equal(await resolveAssigneeId({ id: 1, assignedTo: {} }), null);
});

test("wiring: scheduleWebhookMeeting asks for the assignee before it gives up; the update path passes the employee it just assigned", () => {
  const src = fs.readFileSync(path.join(__dirname, "../services/operationalServices.js"), "utf8");
  assert.match(src, /require\("\.\.\/utils\/leadAssignee"\)/);
  assert.match(src, /if \(!employeeId\) employeeId = await resolveLeadAssigneeId\(tenantId, lead\);\s*\n\s*if \(!employeeId\) \{\s*\n\s*console\.warn\(`\[webhookMeeting\]/,
    "the lookup happens right before the 'no assigned employee' skip");
  assert.match(src, /employeeId: updateFields\.assignedTo \|\| getEmpId\(updatedLead\.assignedTo\)/, "the update path prefers the employee set by this very call");
});
