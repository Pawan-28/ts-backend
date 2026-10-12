// Run: node --test src/utils/uploadFilter.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { isAllowedUpload } = require("./uploadFilter");

test("documents, images, sheets and media are accepted", () => {
  for (const [name, mimetype] of [["brochure.PDF", "application/pdf"], ["slip.jpg", "image/jpeg"], ["leads.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], ["leads.csv", "text/csv"], ["call.mp3", "audio/mpeg"], ["notes.txt", "text/plain"]]) {
    assert.equal(isAllowedUpload({ originalname: name, mimetype }), true, name);
  }
});

test("pages, scripts, vector images with scripts and programs are refused", () => {
  for (const [name, mimetype] of [["x.html", "text/html"], ["x.svg", "image/svg+xml"], ["x.js", "application/javascript"], ["x.exe", "application/x-msdownload"], ["x.php", "application/x-php"], ["noext", "application/pdf"], ["evil.pdf.html", "text/html"], ["x.pdf", "text/html"]]) {
    assert.equal(isAllowedUpload({ originalname: name, mimetype }), false, name);
  }
  assert.equal(isAllowedUpload(null), false);
});
