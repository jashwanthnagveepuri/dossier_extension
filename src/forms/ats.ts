import type { Frame, Page } from "playwright";

import type { Site } from "../select/canonical.js";

// What differs between sites: how to get to the form, where it is, how to
// submit it and how to tell it worked. Everything else is shared.

export type SiteForm = { frame: Frame; root: string };

const SUCCESS_TEXT = /thank you for (applying|your application|your interest)|application (has been |was )?(submitted|received)|we('ve| have) received your application|successfully (submitted|applied)/i;
const SUCCESS_URL = /confirmation|thank|thanks|submitted|success/i;

/** The selector findApplicationForm marks the right form with. */
const FORM = "form[data-applier-form]";

/**
 * Marks the application form among all the forms on a page (job boards also
 * have job-alert, search and newsletter forms, often hidden): the visible one
 * with a file upload or a submit-application button, else the visible one
 * with the most fields. Retries until `timeoutMs`, since forms render late.
 */
async function findApplicationForm(frame: Frame, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await frame
      .evaluate(() => {
        const visible = (el: Element) => {
          const box = (el as HTMLElement).getBoundingClientRect();
          return box.width > 0 && box.height > 0 && getComputedStyle(el as HTMLElement).visibility !== "hidden";
        };
        const forms = Array.from(document.querySelectorAll("form")).filter(visible);
        const score = (form: HTMLFormElement) =>
          (form.querySelector("input[type='file']") ? 100 : 0) +
          (/submit (your )?application|apply/i.test(Array.from(form.querySelectorAll("button, input[type='submit']")).map((b) => (b as HTMLElement).innerText || (b as HTMLInputElement).value).join(" ")) ? 50 : 0) +
          form.querySelectorAll("input, select, textarea").length;
        const best = forms.sort((a, b) => score(b) - score(a))[0];
        document.querySelectorAll("form[data-applier-form]").forEach((form) => form.removeAttribute("data-applier-form"));
        if (!best || score(best) < 3) return false;
        best.setAttribute("data-applier-form", "");
        return true;
      })
      .catch(() => false);
    if (found) return true;
    await frame.page().waitForTimeout(1_000);
  }
  return false;
}

/**
 * The Greenhouse board names a company page might use: the one named in the
 * page's Greenhouse embed script, then guesses from the site address
 * (acme.com → "acme", careers.globex-corp.com → "globexcorp").
 */
export function greenhouseBoardGuesses(pageHtml: string, url: string): string[] {
  const found = [
    ...pageHtml.matchAll(/greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=|embed\/job_app\?for=)([A-Za-z0-9_-]+)/g),
    ...pageHtml.matchAll(/job-boards\.greenhouse\.io\/([A-Za-z0-9_-]+)\/jobs/g),
    ...pageHtml.matchAll(/boards\.greenhouse\.io\/([A-Za-z0-9_-]+)\/jobs/g),
  ].map((m) => m[1]);
  const host = new URL(url).hostname.replace(/^(www|careers|jobs|cms|apply)\./, "").split(".")[0];
  return [...new Set([...found, host, host.replace(/-/g, ""), `${host}inc`].filter((name) => name && name !== "embed"))];
}

/** For a company page with ?gh_jid=, opens that job's form on Greenhouse itself; null if none of the guesses work. */
async function openGreenhouseDirect(page: Page, url: string): Promise<SiteForm | null> {
  const id = new URL(url).searchParams.get("gh_jid");
  if (!id) return null;
  let html = "";
  let frameUrls: string[] = [];
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => undefined);
    // The embed script adds its iframe late; give it a moment.
    await page.locator("iframe[src*='greenhouse.io']").first().waitFor({ state: "attached", timeout: 8_000 }).catch(() => undefined);
    html = await page.content();
    frameUrls = page.frames().map((f) => f.url()).filter((u) => /greenhouse\.io\/.*job_app/.test(u));
  } catch {
    // The company page didn't load; the address alone still gives a guess.
  }
  // 1. The exact form the company page embeds, opened on its own (no iframe to lose track of).
  // 2. Greenhouse's embed form for each board guess: it never redirects back to the company site.
  // 3. The board's job page (some boards redirect this one to the company site, so it comes last).
  const boards = greenhouseBoardGuesses(html, url).slice(0, 4);
  const candidates = [
    ...frameUrls,
    ...boards.map((board) => `https://job-boards.greenhouse.io/embed/job_app?for=${board}&token=${id}`),
    ...boards.map((board) => `https://job-boards.greenhouse.io/${board}/jobs/${id}`),
  ];
  for (const direct of [...new Set(candidates)]) {
    const response = await page.goto(direct, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
    if (!response || response.status() >= 400) continue;
    await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => undefined);
    if (!new URL(page.url()).hostname.endsWith("greenhouse.io")) continue; // redirected back to the company site
    if (await findApplicationForm(page.mainFrame(), 10_000)) return { frame: page.mainFrame(), root: FORM };
  }
  return null;
}

/** Opens the posting and returns the frame and selector the form lives in. */
export async function openForm(page: Page, site: Site, url: string): Promise<SiteForm> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => undefined);

  // A company careers page with ?gh_jid= embeds a Greenhouse form, often late or behind buttons.
  // Going straight to the Greenhouse form is more reliable.
  if (site === "greenhouse" && !new URL(url).hostname.endsWith("greenhouse.io")) {
    const direct = await openGreenhouseDirect(page, url);
    if (direct) return direct;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => undefined);
  }

  // Greenhouse on a company's own site puts the form in an iframe (#grnhse_iframe).
  const embedded = page.locator("iframe#grnhse_iframe, iframe[src*='greenhouse.io']").first();
  if (site === "greenhouse" && (await embedded.count())) {
    const frame = await (await embedded.elementHandle())?.contentFrame();
    if (frame && (await findApplicationForm(frame, 20_000))) return { frame, root: FORM };
  }

  const frame = page.mainFrame();
  if (await findApplicationForm(frame, 5_000)) return { frame, root: FORM };

  // Some postings show the form only after an Apply button.
  const apply = page
    .getByRole("button", { name: /^\s*apply( for this job| now)?\s*$/i })
    .or(page.getByRole("link", { name: /^\s*apply( for this job| now)?\s*$/i }))
    .first();
  if (await apply.count()) await apply.click().catch(() => undefined);
  if (await findApplicationForm(frame, 20_000)) return { frame, root: FORM };
  throw new Error("Couldn't find the application form on this page (the job may be closed, or the page needs a login).");
}

/** A CAPTCHA a person has to solve. The applier never tries to get past one. */
export async function hasCaptchaChallenge(frame: Frame): Promise<boolean> {
  const page = frame.page();
  const challenge = page.locator("iframe[src*='hcaptcha.com'][title*='challenge' i], iframe[src*='recaptcha'][title*='challenge' i], iframe[src*='challenges.cloudflare.com']");
  for (let i = 0; i < (await challenge.count()); i++) if (await challenge.nth(i).isVisible().catch(() => false)) return true;
  return /verify (that )?you('| a)re (a )?human|complete the captcha/i.test(await page.locator("body").innerText().catch(() => ""));
}

export type SubmitOutcome = { ok: true } | { ok: false; why: string; needsCode?: boolean };

const CODE_PROMPT = /verification code (was|has been) sent|enter the \d+-character code|security code/i;

/** The boxes a site's emailed security code goes into: several one-character boxes, or one field. */
async function codeInputs(frame: Frame) {
  const boxes = frame.locator("input[maxlength='1']:visible");
  if ((await boxes.count()) >= 4) return { boxes, single: null };
  const single = frame.locator("input[name*='security' i]:visible, input[id*='security' i]:visible, input[name*='code' i]:visible, input[autocomplete='one-time-code']:visible").first();
  return { boxes: null, single: (await single.count()) ? single : null };
}

/** Types an emailed security code and submits again. */
export async function submitWithCode(form: SiteForm, code: string): Promise<SubmitOutcome> {
  const { boxes, single } = await codeInputs(form.frame);
  if (boxes) {
    const count = await boxes.count();
    for (let i = 0; i < Math.min(count, code.length); i++) await boxes.nth(i).fill(code[i]);
  } else if (single) await single.fill(code);
  else return { ok: false, why: "couldn't find where to type the security code" };
  return submit(form);
}

/** Clicks submit and waits to see what happened. */
export async function submit(form: SiteForm): Promise<SubmitOutcome> {
  const { frame, root } = form;
  const page = frame.page();
  const button = frame.locator(`${root} button[type='submit'], ${root} input[type='submit'], ${root} button:has-text("Submit application"), ${root} button:has-text("Submit Application"), button#btn-submit`).first();
  if (!(await button.count())) return { ok: false, why: "no submit button found" };
  const before = page.url();
  await button.click();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    if (page.url() !== before && SUCCESS_URL.test(page.url())) return { ok: true };
    const body = await frame.locator("body").innerText().catch(() => "");
    if (SUCCESS_TEXT.test(body)) return { ok: true };
    if (await hasCaptchaChallenge(frame)) return { ok: false, why: "a CAPTCHA appeared after submitting" };
    if (CODE_PROMPT.test(body) && ((await codeInputs(frame)).boxes || (await codeInputs(frame)).single)) {
      return { ok: false, why: "the site emailed a security code to confirm the application", needsCode: true };
    }
  }
  const errors = await frame.locator("[class*='error' i]:visible, [aria-invalid='true']").allInnerTexts().catch(() => [] as string[]);
  const shown = errors.map((text) => text.trim()).filter(Boolean).slice(0, 3).join(" | ");
  return { ok: false, why: shown ? `the form showed errors: ${shown}` : "no confirmation after submitting" };
}
