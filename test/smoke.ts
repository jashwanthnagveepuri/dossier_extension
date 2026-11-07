// Runs the form code through tsx, the way `npm run try` and `npm run run` do,
// on local Greenhouse- and Lever-style pages and on a saved copy of a real
// Greenhouse page. `npm run smoke`. Exits non-zero on any failure.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium } from "playwright";

import { loadAnswerBank } from "../src/config.js";
import { applyOnPage, describeFilled } from "../src/forms/apply.js";
import { PAGE_SHIM } from "../src/forms/page.js";

process.env.APPLIER_EXAMPLE_BANK = "1"; // the made-up example, so results are the same on every machine
const bank = loadAnswerBank();
const dir = mkdtempSync(join(tmpdir(), "applier-smoke-"));
const resume = join(dir, "resume.pdf");
writeFileSync(resume, "%PDF-1.4 smoke");
const fixture = (name: string) => pathToFileURL(join(import.meta.dirname, "fixtures", name)).toString();

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined });
const context = await browser.newContext();
if (!process.argv.includes("--no-shim")) await context.addInitScript({ content: PAGE_SHIM });
let failed = 0;
for (const [name, site, expected] of [
  ["greenhouse.html", "greenhouse", "dry-run"],
  ["lever.html", "lever", "needs-you"],
  ["greenhouse-real-saved.html", "greenhouse", "any"],
] as const) {
  const page = await context.newPage();
  try {
    const outcome = await applyOnPage(page, { site, key: name, applyUrl: fixture(name) }, { bank, ai: null, dryRun: true, evidenceDir: dir, log: () => undefined, files: { resume } });
    const ok = expected === "any" || outcome.outcome === expected;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${outcome.outcome}`);
    if (name.includes("real")) console.log(describeFilled(outcome.filled).map((line) => `   ${line}`).join("\n"));
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}: ${String(error).split("\n")[0]}`);
  }
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
