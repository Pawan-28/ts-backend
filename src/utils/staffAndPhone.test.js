// Run: node --test src/utils/staffAndPhone.test.js
// E-11 / E-15: staff numbers are not leads, a phone is not a lead name, and a new lead needs a real mobile number.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { isPlausibleLeadPhone, looksLikePhone, leadNameFromCallClient } = require("./phone");
const { isStaffPhone, last10 } = require("./staffPhones");

const read = (rel) => fs.readFileSync(path.join(__dirname, "../..", rel), "utf8");

test("a new lead needs a real Indian mobile (starts with 6-9); other countries and empty are left alone", () => {
  for (const ok of ["9876543210", "+91 98765 43210", "919876543210", "6000000000", "+65 91234567", "", undefined, null]) assert.equal(isPlausibleLeadPhone(ok), true, String(ok));
  for (const bad of ["1234567890", "0123456789", "5876543210", "2212345678"]) assert.equal(isPlausibleLeadPhone(bad), false, bad);
  const { createLeadSchema } = require("../validators/operationalSchemas");
  assert.equal(createLeadSchema.safeParse({ leadName: "A", phone: "1234567890" }).success, false);
  assert.equal(createLeadSchema.safeParse({ leadName: "A", phone: "9876543210" }).success, true);
  assert.equal(createLeadSchema.safeParse({ leadName: "A" }).success, true, "phone stays optional");
});

test("a phone number is never used as the lead name", () => {
  assert.equal(looksLikePhone("9876543210"), true);
  assert.equal(looksLikePhone("+91 98765-43210"), true);
  assert.equal(looksLikePhone("Rahul 2"), false);
  assert.equal(leadNameFromCallClient("9876543210"), "Unknown Lead");
  assert.equal(leadNameFromCallClient("  "), "Unknown Lead");
  assert.equal(leadNameFromCallClient("Rahul Sharma"), "Rahul Sharma");
});

test("staff numbers match by their last 10 digits", () => {
  const staff = new Set([last10("+91 98765 43210")]);
  assert.equal(isStaffPhone(staff, "919876543210"), true);
  assert.equal(isStaffPhone(staff, "98765-43210"), true);
  assert.equal(isStaffPhone(staff, "9123456789"), false);
  assert.equal(isStaffPhone(staff, ""), false);
});

test("wiring: call sync and the Callyzer webhook skip staff numbers and never name a lead after a phone", () => {
  const sync = read("src/services/callyzerService.js");
  assert.match(sync, /isStaffPhone\(staffPhones, log\.client_number\)\) \{\s*return false;/);
  assert.match(sync, /const leadName = leadNameFromCallClient\(log\.client_name\);/);
  const hook = read("src/routes/operationalRoutes.js");
  assert.match(hook, /isStaffPhone\(staffPhones, log\.client_number\)\) \{\s*skipped \+= 1;\s*continue;/);
  assert.match(hook, /const leadName = leadNameFromCallClient\(log\.client_name\);/);
});
