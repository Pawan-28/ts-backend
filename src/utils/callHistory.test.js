// Run: node --test src/utils/callHistory.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { historyColumn, furthestColumn, personKeySql, HISTORY_COLUMN_RANK } = require("./callHistory");

const h = (o = {}) => ({ conversation: 0, short: 0, noPickup: 0, rejected: 0, missedIncoming: 0, incomingShort: 0, ...o });

test("priority: Conversation > Short Call > Not Pick > Lead", () => {
  assert.equal(historyColumn(null), "lead");
  assert.equal(historyColumn(h()), "lead");
  assert.equal(historyColumn(h({ noPickup: 1 })), "not_pick");
  assert.equal(historyColumn(h({ noPickup: 5 })), "not_pick");
  assert.equal(historyColumn(h({ short: 1, noPickup: 9 })), "short_call");
  assert.equal(historyColumn(h({ conversation: 1, short: 4, noPickup: 9 })), "conversation_2min");
});

test("Rejected, Missed (incoming) and Incoming short never leave Lead on their own", () => {
  assert.equal(historyColumn(h({ rejected: 3 })), "lead");
  assert.equal(historyColumn(h({ missedIncoming: 2 })), "lead");
  assert.equal(historyColumn(h({ incomingShort: 4 })), "lead");
  assert.equal(historyColumn(h({ rejected: 3, missedIncoming: 2, incomingShort: 4 })), "lead");
  // ...but one real unanswered dial next to a rejected one is Not Pick (from the unanswered dial only)
  assert.equal(historyColumn(h({ rejected: 3, noPickup: 1 })), "not_pick");
});

test("furthestColumn keeps a stored stage that is further along than the history", () => {
  assert.equal(furthestColumn("conversation_2min", "not_pick"), "conversation_2min"); // legacy "Contacted"
  assert.equal(furthestColumn("lead", "short_call"), "short_call");
  assert.equal(furthestColumn("not_pick", "conversation_2min"), "conversation_2min");
  assert.equal(furthestColumn("short_call", "short_call"), "short_call");
  assert.deepEqual(Object.keys(HISTORY_COLUMN_RANK), ["lead", "not_pick", "short_call", "conversation_2min"]);
});

test("person key SQL uses the last 10 digits, else the lead id (same key as the frontend)", () => {
  const sql = personKeySql("l");
  assert.match(sql, /RIGHT\(/);
  assert.match(sql, /CONCAT\('id:', l\.id\)/);
  assert.match(sql, /\[\^0-9\]/);
});
