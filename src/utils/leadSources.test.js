// Run: node --test src/utils/leadSources.test.js
// ONE list of sources: what the admin Sources page shows = what every source dropdown offers. "+ Add new..." adds to that list.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const S = require("./leadSources");

const FE_DIR = path.resolve(__dirname, "../../../frontend/src/lib");
let FE;
test.before(async () => { FE = await import(pathToFileURL(path.join(FE_DIR, "leadSource.js")).href); });

let n = 0;
const lead = (o = {}) => { n += 1; return { id: 1000 + n, lead_name: `Person ${n}`, email: `p${n}@acme.in`, phone: `98${String(10000000 + n)}`, created_at: "2026-09-01T10:00:00Z", ...o }; };
// the frontend shape of the same row (what the Sources page really groups)
const feLead = (r) => ({ ...r, createdAt: r.created_at, sourceMeta: typeof r.source_meta === "string" ? JSON.parse(r.source_meta) : (r.source_meta || {}), formName: r.form_name });

const LEADS = [
  lead({ source: "meta_ads" }), lead({ source: "meta_ads" }), lead({ source: "Meta", source_meta: JSON.stringify({ channel: "Instagram" }) }),
  lead({ source: "google_ads" }),
  lead({ source: "website" }), lead({ source: "Website" }),
  lead({ source: "referral" }),
  lead({ source: "n8n", source_meta: JSON.stringify({ integration: "n8n" }) }),
  lead({ source: "n8n", source_meta: JSON.stringify({ channel: "Meta", integration: "n8n" }) }),   // n8n lead whose channel is Meta
  lead({ source: "callyzer" }),                                                                    // internal import: never a source
  lead({ source: "manual" }),                                                                      // legacy manual, no channel: not a source
  lead({ source: "manual", source_meta: JSON.stringify({ channel: "LinkedIn" }) }),                // manual WITH a channel -> LinkedIn
  lead({ source: "meta_ads", lead_name: "Test Lead" }),                                            // demo row
  lead({ source: "google_ads", email: "someone@example.com" }),                                    // demo row
  lead({ source: "Podcast Ads" }),                                                                 // unknown name: only a source once the admin created it
  lead({ source: "meta_ads", phone: "9000012345" }),                                               // demo phone
];

test("normalisation and grouping are the frontend's own rules (parity on a table of leads)", () => {
  for (const key of ["", "Meta", "facebook ads", "Instagram", "Google Ads", "WhatsApp", "wa group", "Website", "organic", "LinkedIn", "referral",
    "Campaign", "Landing Page", "manual", "n8n", "webhook", "zapier", "callyzer", "API", "Podcast Ads", "  Radio  "]) {
    assert.equal(S.normalizeSourceKey(key), FE.resolveLeadSourceKey ? S.normalizeSourceKey(key) : null);
  }
  for (const row of LEADS) {
    assert.equal(S.resolveLeadSourceKey(row), FE.resolveLeadSourceKey(feLead(row)), `key for ${JSON.stringify(row.source)}`);
    assert.equal(S.isSourceDashboardLead(row), FE.isSourceDashboardLead(feLead(row)), `dashboard lead ${row.id}`);
  }
});

test("the list equals what the admin Sources page shows (keys + lead counts), with and without custom sources", () => {
  for (const custom of [[], [{ key: "podcast_ads", label: "Podcast Ads" }]]) {
    const be = S.listLeadSources(LEADS, { customSources: custom });
    const feGroups = FE.aggregateLeadsBySource(FE.filterLeadsForSourceDashboard(LEADS.map(feLead), custom), custom);
    assert.deepEqual(new Map(be.map((s) => [s.key, s.leadCount])), new Map(feGroups.map((g) => [g.key, g.leadCount])));
    assert.deepEqual(new Map(be.map((s) => [s.key, s.label])), new Map(feGroups.map((g) => [g.key, g.label])));
  }
});

test("only real sources: no callyzer import, no legacy manual, no demo leads, no unknown name nobody created", () => {
  const keys = S.listLeadSources(LEADS).map((s) => s.key);
  assert.deepEqual(keys.sort(), ["google_ads", "linkedin", "meta_ads", "n8n", "referral", "website"].sort());
  assert.ok(!keys.includes("callyzer") && !keys.includes("manual") && !keys.includes("podcast_ads"));
});

test("a dismissed source is hidden until a NEWER lead arrives (same rule as the page)", () => {
  const dismissed = { referral: "2026-09-15T00:00:00Z" };
  assert.ok(!S.listLeadSources(LEADS, { dismissed }).some((s) => s.key === "referral"));
  const withNew = [...LEADS, lead({ source: "referral", created_at: "2026-09-20T00:00:00Z" })];
  assert.ok(S.listLeadSources(withNew, { dismissed }).some((s) => s.key === "referral"));
  const feHidden = FE.aggregateLeadsBySource(FE.filterLeadsForSourceDashboard(LEADS.map(feLead))).filter((g) => !FE.isSourceDismissed(g, dismissed[g.key]));
  assert.equal(feHidden.some((g) => g.key === "referral"), false);
});

test("source names typed in a dropdown are validated", () => {
  assert.equal(S.validateSourceLabel("").ok, false);
  assert.equal(S.validateSourceLabel(" a ").ok, false);
  assert.equal(S.validateSourceLabel("x".repeat(41)).ok, false);
  assert.equal(S.validateSourceLabel("<script>").ok, false);
  assert.equal(S.validateSourceLabel("Callyzer").ok, false, "system channel is reserved");
  const ok = S.validateSourceLabel("  Podcast   Ads ");
  assert.deepEqual([ok.ok, ok.label, ok.key], [true, "Podcast Ads", "podcast_ads"]);
  assert.equal(S.validateSourceLabel("Radio & TV").ok, true);
});

test("+ Add new: a new source is saved, appears on the admin Sources page at once and is never duplicated", () => {
  const settings = { dismissedSources: {}, customSources: [] };
  const plan = S.planAddSource("Podcast Ads", { leads: LEADS, settings, now: new Date("2026-10-08T10:00:00Z") });
  assert.equal(plan.status, "created");
  assert.deepEqual(plan.source, { key: "podcast_ads", label: "Podcast Ads", leadCount: 1, custom: true }, "an earlier lead already tagged Podcast Ads now counts");
  assert.equal(S.planAddSource("Radio", { leads: [], settings }).source.leadCount, 0, "a brand-new source starts at 0 leads but is on the page");
  assert.deepEqual(plan.nextSettings.customSources, [{ key: "podcast_ads", label: "Podcast Ads", createdAt: "2026-10-08T10:00:00.000Z" }]);
  assert.deepEqual(settings.customSources, [], "input settings are not mutated");
  // the admin page (frontend grouping, fed the saved settings) shows it right away
  const page = FE.aggregateLeadsBySource(FE.filterLeadsForSourceDashboard(LEADS.map(feLead), plan.nextSettings.customSources), plan.nextSettings.customSources);
  assert.ok(page.some((g) => g.key === "podcast_ads" && g.label === "Podcast Ads" && g.leadCount === 1), "the earlier 'Podcast Ads' lead now counts too");
  // adding it again - any casing - returns the existing one
  for (const again of ["Podcast Ads", "podcast ads", "  PODCAST  ADS "]) {
    const p2 = S.planAddSource(again, { leads: LEADS, settings: plan.nextSettings });
    assert.equal(p2.status, "exists", again);
    assert.equal(p2.source.key, "podcast_ads");
  }
  // names that are already admin sources never create a duplicate
  for (const dup of ["Meta", "meta", "Instagram", "Google Ads", "website", "Referral"]) {
    assert.equal(S.planAddSource(dup, { leads: LEADS, settings }).status, "exists", dup);
  }
  assert.equal(S.planAddSource("x", { leads: LEADS, settings }).status, "invalid");
});

test("+ Add new for a catalog source with no leads yet (e.g. WhatsApp) puts it on the page; a dismissed one is brought back", () => {
  const p = S.planAddSource("WhatsApp", { leads: LEADS, settings: {} });
  assert.equal(p.status, "created");
  assert.equal(p.source.key, "whatsapp");
  assert.equal(p.source.label, "WhatsApp");
  const settings = { dismissedSources: { referral: "2026-09-15T00:00:00Z" } };
  assert.ok(!S.listLeadSources(LEADS, { dismissed: settings.dismissedSources }).some((s) => s.key === "referral"));
  const back = S.planAddSource("Referral", { leads: LEADS, settings });
  assert.equal(back.status, "created");
  assert.equal(back.nextSettings.dismissedSources.referral, undefined);
  assert.ok(S.listLeadSources(LEADS, { dismissed: back.nextSettings.dismissedSources, customSources: back.nextSettings.customSources }).some((s) => s.key === "referral"));
});

test("a lead saved with a custom source (as the Add Lead form does) counts under it on the Sources page", () => {
  const settings = S.planAddSource("Podcast Ads", { leads: LEADS, settings: {} }).nextSettings;
  const saved = lead({ source: "Podcast Ads", source_meta: JSON.stringify({ integration: "admin", channel: "Podcast Ads" }) });
  const list = S.listLeadSources([...LEADS, saved], { customSources: settings.customSources });
  assert.equal(list.find((s) => s.key === "podcast_ads").leadCount, 2);
  // BEFORE the source was created that lead was not on the page at all
  assert.ok(!S.listLeadSources([saved]).some((s) => s.key === "podcast_ads"));
});

test("endpoints exist and the GET settings response carries the custom sources", () => {
  const fs = require("node:fs");
  const routes = fs.readFileSync(path.resolve(__dirname, "../routes/operationalRoutes.js"), "utf8");
  assert.match(routes, /router\.get\("\/lead-sources"/);
  assert.match(routes, /router\.post\("\/lead-sources"/);
  assert.match(routes, /leadSourcesUtil\.planAddSource\(/);
  const settings = fs.readFileSync(path.resolve(__dirname, "../controllers/settingsController.js"), "utf8");
  assert.match(settings, /customSources: Array\.isArray\(s\.customSources\)/);
});
