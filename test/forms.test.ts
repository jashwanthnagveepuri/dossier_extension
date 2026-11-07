import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadAnswerBank } from "../src/config.js";
import { applyOnPage } from "../src/forms/apply.js";
import { PAGE_SHIM } from "../src/forms/page.js";

// Fills local copies of Greenhouse- and Lever-style forms in a real browser.
// PLAYWRIGHT_CHROMIUM lets this run against a Chromium that's already installed.

const bank = loadAnswerBank();
const fixture = (name: string) => pathToFileURL(join(import.meta.dirname, "fixtures", name)).toString();
let browser: Browser;
let context: BrowserContext;
const dir = mkdtempSync(join(tmpdir(), "applier-"));
const resume = join(dir, "resume.pdf");
writeFileSync(resume, "%PDF-1.4 test");

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined });
  context = await browser.newContext();
  await context.addInitScript({ content: PAGE_SHIM });
});
afterAll(async () => browser?.close());

const value = (page: import("playwright").Page, selector: string) => page.locator(selector).inputValue();

describe("Greenhouse-style form", () => {
  it("fills every field from the answer bank and submits", async () => {
    const page = await context.newPage();
    const outcome = await applyOnPage(page, { site: "greenhouse", key: "t", applyUrl: fixture("greenhouse.html") }, { bank, ai: null, dryRun: true, evidenceDir: dir, log: () => undefined, files: { resume } });
    if (outcome.outcome === "needs-you") throw new Error(outcome.why.join("; "));
    expect(outcome.outcome).toBe("dry-run");
    expect(await value(page, "#first_name")).toBe("Alex");
    expect(await value(page, "#last_name")).toBe("Rivera");
    expect(await value(page, "#preferred_name")).toBe("Alex");
    expect(await value(page, "#email")).toBe("alex.rivera@example.com");
    expect(await value(page, "#candidate-location")).toBe("Springfield, Illinois, United States");
    expect(await value(page, "#q1")).toBe("https://www.linkedin.com/in/alex-rivera-example");
    // React-select layout: the choice shows beside the input, not in it.
    expect(await page.locator("#q3").getAttribute("data-chosen")).toBe("Yes");
    expect(await page.locator("#q4").getAttribute("data-chosen")).toBe("Yes");
    expect(await value(page, "#q3")).toBe("");
    // The pre-submit check reads the shown choice itself, not just what the applier clicked.
    const { shownValue } = await import("../src/forms/legal-check.js");
    expect(await shownValue(page.mainFrame(), (await page.locator("#q3").getAttribute("data-applier-id"))!)).toBe("Yes");
    expect(await value(page, "#q5")).toBe("$110,000–$140,000");
    expect(await page.locator("#q6 option:checked").innerText()).toBe("Company Website");
    expect(await page.locator("#gender option:checked").innerText()).toBe("Female");
    expect(await page.locator("#hispanic option:checked").innerText()).toBe("No");
    expect(await page.locator("#veteran option:checked").innerText()).toBe("I am not a protected veteran");
    expect(await page.locator("#disability option:checked").innerText()).toMatch(/^No, I do not have a disability/);
    expect(await page.locator("#ack").isChecked()).toBe(true);
    expect(await page.locator("#resume").evaluate((el: HTMLInputElement) => el.files?.[0]?.name)).toBe("resume.pdf");
    expect(await page.locator("#cover_letter").evaluate((el: HTMLInputElement) => el.files?.length)).toBe(0);
    await page.close();
  }, 60_000);

  it("submits and sees the confirmation when it isn't a dry run", async () => {
    const page = await context.newPage();
    const outcome = await applyOnPage(page, { site: "greenhouse", key: "t", applyUrl: fixture("greenhouse.html") }, { bank, ai: null, dryRun: false, evidenceDir: dir, log: () => undefined, files: { resume } });
    expect(outcome.outcome).toBe("submitted");
    await page.close();
  }, 60_000);
});

describe("Lever-style form", () => {
  it("fills what it knows and leaves an unknown required question to you", async () => {
    const page = await context.newPage();
    const outcome = await applyOnPage(page, { site: "lever", key: "t", applyUrl: fixture("lever.html") }, { bank, ai: null, dryRun: false, evidenceDir: dir, log: () => undefined, files: { resume } });
    expect(outcome.outcome).toBe("needs-you");
    if (outcome.outcome !== "needs-you") return;
    expect(outcome.why.join(" ")).toMatch(/Why are you interested/);
    expect(outcome.why).toHaveLength(1);
    expect(await value(page, "input[name='name']")).toBe("Alex Rivera");
    expect(await value(page, "input[name='org']")).toBe("Example Bank");
    expect(await value(page, "input[name='urls[GitHub]']")).toBe("https://github.com/alex-rivera-example");
    expect(await value(page, "input[name='urls[Portfolio]']")).toBe("https://alex-rivera.example.com/");
    expect(await page.locator("input[name='cards[abc][field0]'][value='Yes']").isChecked()).toBe(true);
    expect(await page.locator("select[name='eeo[race]'] option:checked").innerText()).toBe("White (Not Hispanic or Latino)");
    expect(await page.locator("select[name='eeo[veteran]'] option:checked").innerText()).toBe("I am not a veteran");
    expect(await page.locator("body").innerText()).not.toMatch(/Application submitted/);
    await page.close();
  }, 60_000);
});

describe("AI answers for questions the bank doesn't cover", () => {
  it("types the AI's answer, records it, and no longer stops", async () => {
    const asked: string[] = [];
    const fakeAi = {
      matchQuestion: async () => null,
      answerQuestion: async (input: { question: string; kind: string }) => {
        asked.push(input.question);
        if (input.kind === "choice") return { decision: "answer" as const, value: "Yes", basis: "5 years in the profile" };
        return { decision: "answer" as const, value: "I build Java and Spring Boot platforms end to end.", basis: "current role" };
      },
    } as unknown as import("../src/ai.js").Ai;
    const page = await context.newPage();
    const outcome = await applyOnPage(page, { site: "lever", key: "t", applyUrl: fixture("lever.html") }, { bank, ai: fakeAi, dryRun: true, evidenceDir: dir, log: () => undefined, files: { resume }, profile: { name: "test" }, posting: "Backend role" });
    expect(outcome.outcome).toBe("dry-run");
    // The required text question and the optional yes/no; never the optional free-text box.
    expect(asked).toEqual(["Why are you interested in this role?", "Do you have at least five years experience?"]);
    expect(await page.locator("select[name='cards[abc][field2]'] option:checked").innerText()).toBe("Yes");
    expect(await page.locator("textarea[name='cards[abc][field3]']").inputValue()).toBe("");
    expect(await page.locator("textarea[name='cards[abc][field1]']").inputValue()).toBe("I build Java and Spring Boot platforms end to end.");
    expect(outcome.aiAnswers).toHaveLength(2);
    await page.close();
  });

  it("still stops when the AI can't back an answer", async () => {
    const fakeAi = { matchQuestion: async () => null, answerQuestion: async () => ({ decision: "needs_you" as const, basis: "not in profile" }) } as unknown as import("../src/ai.js").Ai;
    const page = await context.newPage();
    const outcome = await applyOnPage(page, { site: "lever", key: "t", applyUrl: fixture("lever.html") }, { bank, ai: fakeAi, dryRun: true, evidenceDir: dir, log: () => undefined, files: { resume }, profile: { name: "test" }, posting: "" });
    expect(outcome.outcome).toBe("needs-you");
    await page.close();
  });
});

describe("Acme-style form: security code, look-alike options, late questions", () => {
  it("picks the US sponsorship option, fills the late race question, and enters the emailed code", async () => {
    const page = await context.newPage();
    let askedSince: Date | null = null;
    const outcome = await applyOnPage(page, { site: "greenhouse", key: "t", applyUrl: `${fixture("greenhouse-code.html")}?no-lookalike` }, {
      bank, ai: null, dryRun: false, evidenceDir: dir, log: () => undefined, files: { resume },
      getCode: async (since) => { askedSince = since; return "AB12cd34"; },
    });
    expect(outcome.outcome).toBe("submitted");
    expect(askedSince).not.toBeNull();
    await page.close();
  });

  it("blocks a foreign-visa option even when something (here a bad AI answer) chose it", async () => {
    const page = await context.newPage();
    const ai = { matchQuestion: async () => null, answerQuestion: async () => ({ decision: "answer" as const, value: "Yes, Canada work permit", basis: "test" }) } as unknown as import("../src/ai.js").Ai;
    const outcome = await applyOnPage(page, { site: "greenhouse", key: "t", applyUrl: fixture("greenhouse-code.html") }, {
      bank, ai, profile: {}, dryRun: false, evidenceDir: dir, log: () => undefined, files: { resume }, getCode: async () => "AB12cd34",
    });
    expect(outcome.outcome).toBe("needs-you");
    if (outcome.outcome === "needs-you") expect(outcome.why.join(" ")).toMatch(/legal check: .*another country/);
    expect(await page.locator("body").innerText()).not.toMatch(/Thank you/);
    await page.close();
  });

  it("never guesses between look-alike options, and stops instead", async () => {
    const page = await context.newPage();
    const outcome = await applyOnPage(page, { site: "greenhouse", key: "t", applyUrl: fixture("greenhouse-code.html") }, { bank, ai: null, dryRun: false, evidenceDir: dir, log: () => undefined, files: { resume } });
    expect(outcome.outcome).toBe("needs-you");
    expect(await page.locator("#sp option:checked").innerText()).toBe("Yes, US H-1B Visa");
    expect(await page.locator("#rc option:checked").innerText()).toBe("White");
    // Acme's searchable dropdown with no U.S. option: never the Netherlands one by default.
    expect(await page.locator("#sp2").inputValue()).not.toMatch(/Netherlands/);
    if (outcome.outcome === "needs-you") expect(outcome.questions.map((q) => q.label).join(" ")).toMatch(/searchable/);
    await page.close();
  });
});

describe("your saved answers (npm run pending)", () => {
  it("uses them before the answer bank, the AI, or stopping", async () => {
    const { writeFileSync, rmSync, existsSync, readFileSync } = await import("node:fs");
    const file = join(import.meta.dirname, "..", "config", "my-answers.yaml");
    const before = existsSync(file) ? readFileSync(file, "utf8") : null;
    writeFileSync(file, 'answers:\n  - question: "Why are you interested in this role?"\n    answer: "Saved answer text."\n    only_for: app-1\n');
    try {
      const page = await context.newPage();
      const outcome = await applyOnPage(page, { site: "lever", key: "t", applyUrl: fixture("lever.html") }, { bank, ai: null, dryRun: true, evidenceDir: dir, log: () => undefined, files: { resume }, applicationId: "app-1" });
      expect(outcome.outcome).toBe("dry-run");
      expect(await page.locator("textarea[name='cards[abc][field1]']").inputValue()).toBe("Saved answer text.");
      // only_for another application: not used, so it stops again.
      const other = await context.newPage();
      const second = await applyOnPage(other, { site: "lever", key: "t", applyUrl: fixture("lever.html") }, { bank, ai: null, dryRun: true, evidenceDir: dir, log: () => undefined, files: { resume }, applicationId: "app-2" });
      expect(second.outcome).toBe("needs-you");
      if (second.outcome === "needs-you") expect(second.questions.map((q) => q.label)).toContain("Why are you interested in this role?");
      await page.close();
      await other.close();
    } finally {
      before === null ? rmSync(file) : writeFileSync(file, before);
    }
  });
});

describe("legal check before submit", () => {
  it("refuses to submit when the page shows a different legal answer than the bank", async () => {
    const page = await context.newPage();
    const outcome = await applyOnPage(page, { site: "greenhouse", key: "t", applyUrl: fixture("legal-trap.html") }, { bank, ai: null, dryRun: false, evidenceDir: dir, log: () => undefined, files: { resume } });
    expect(outcome.outcome).toBe("needs-you");
    if (outcome.outcome === "needs-you") expect(outcome.why.join(" ")).toMatch(/legal check: .*another country/);
    expect(await page.locator("body").innerText()).not.toMatch(/Thank you/);
    await page.close();
  });

  it("lets correct answers through", async () => {
    const page = await context.newPage();
    const outcome = await applyOnPage(page, { site: "greenhouse", key: "t", applyUrl: fixture("greenhouse.html") }, { bank, ai: null, dryRun: false, evidenceDir: dir, log: () => undefined, files: { resume } });
    expect(outcome.outcome).toBe("submitted");
    await page.close();
  });
});
