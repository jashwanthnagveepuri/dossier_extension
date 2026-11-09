import type { Frame, Page } from "playwright";

import { identify, type Site } from "../select/canonical.js";

// What differs between sites: how to get to the form, where it is, how to
// submit it and how to tell it worked. Everything else is shared.

export type SiteForm = { frame: Frame; root: string };

const SUCCESS_TEXT = /thank you for (applying|your application|your interest)|application (has been |was )?(submitted|received)|we('ve| have) received your application|successfully (submitted|applied)/i;
const SUCCESS_URL = /confirmation|thank|thanks|submitted|success/i;

/** The selector findApplicationForm marks the right form (or form-like section) with. */
const FORM = "[data-applier-form]";

/** A site that won't let the applier in: an account, a sign-in or a closed posting. The application waits for you. */
export class SiteBlocked extends Error {}

/**
 * Marks the application form among all the forms on a page (job boards also
 * have job-alert, search and newsletter forms, often hidden): the visible one
 * with a file upload or a submit-application button, else the visible one
 * with the most fields. Retries until `timeoutMs`, since forms render late.
 */
export async function findApplicationForm(frame: Frame, timeoutMs: number): Promise<boolean> {
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
        document.querySelectorAll("[data-applier-form]").forEach((el) => el.removeAttribute("data-applier-form"));
        if (best && score(best) >= 3) {
          best.setAttribute("data-applier-form", "");
          return true;
        }
        // Many career sites build the form from plain sections, with no <form> element: use the page itself
        // when it shows enough application fields (an email box or a file upload among at least three).
        const fields = Array.from(document.querySelectorAll("input:not([type='hidden']):not([type='search']), select, textarea, [role='combobox']")).filter(visible);
        const looksLikeApplication = fields.some((f) => /email|file/i.test((f as HTMLInputElement).type) || /email|resume|first.?name/i.test((f as HTMLInputElement).name || f.id));
        if (fields.length >= 3 && looksLikeApplication) {
          document.body.setAttribute("data-applier-form", "");
          return true;
        }
        return false;
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
export function greenhouseBoardGuesses(pageHtml: string, url: string, company?: string): string[] {
  const found = [
    ...pageHtml.matchAll(/greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=|embed\/job_app\?for=)([A-Za-z0-9_-]+)/g),
    ...pageHtml.matchAll(/job-boards\.greenhouse\.io\/([A-Za-z0-9_-]+)\/jobs/g),
    ...pageHtml.matchAll(/boards\.greenhouse\.io\/([A-Za-z0-9_-]+)\/jobs/g),
  ].map((m) => m[1]);
  const host = new URL(url).hostname.replace(/^(www|careers|jobs|cms|apply)\./, "").split(".")[0];
  // The company's name as Dossier lists it ("Toast" → toast, "Coalition, Inc." → coalitioninc, coalition).
  const name = (company ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, "");
  const short = name.replace(/\b(inc|llc|ltd|corp|corporation|co|company|technologies|labs)\b/g, "").replace(/\s+/g, "");
  const fromName = [name.replace(/\s+/g, ""), short];
  return [...new Set([...found, host, ...fromName, host.replace(/-/g, ""), `${host}inc`].filter((n) => n && n !== "embed"))];
}

/** Tries Greenhouse addresses for one job; the first that shows the application form wins. */
async function tryGreenhouse(page: Page, candidates: string[], tried: Set<string>): Promise<SiteForm | null> {
  for (const direct of candidates) {
    if (tried.has(direct)) continue;
    tried.add(direct);
    const response = await page.goto(direct, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
    if (!response || response.status() >= 400) continue;
    await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => undefined);
    if (!new URL(page.url()).hostname.endsWith("greenhouse.io")) continue; // redirected back to the company site
    if (await findApplicationForm(page.mainFrame(), 10_000)) return { frame: page.mainFrame(), root: FORM };
  }
  return null;
}

const greenhouseUrls = (boards: string[], id: string) => [
  // Greenhouse's embed form never redirects back to the company site; the board's job page sometimes does.
  ...boards.map((board) => `https://job-boards.greenhouse.io/embed/job_app?for=${board}&token=${id}`),
  ...boards.map((board) => `https://job-boards.greenhouse.io/${board}/jobs/${id}`),
];

/** For a company page with ?gh_jid=, opens that job's form on Greenhouse itself; null if nothing works. */
async function openGreenhouseDirect(page: Page, url: string, company?: string): Promise<SiteForm | null> {
  const id = new URL(url).searchParams.get("gh_jid");
  if (!id) return null;
  const tried = new Set<string>();

  // 1. Board names guessed from the address alone, without opening the company's site at all
  //    (some career sites cut off automated browsers after a request or two).
  const fromAddress = await tryGreenhouse(page, greenhouseUrls(greenhouseBoardGuesses("", url, company).slice(0, 4), id), tried);
  if (fromAddress) return fromAddress;

  // 2. The company page itself: the exact form it embeds, and the board name in its HTML.
  let html = "";
  let frameUrls: string[] = [];
  try {
    await gotoWithRetry(page, url);
    await page.locator("iframe[src*='greenhouse.io']").first().waitFor({ state: "attached", timeout: 8_000 }).catch(() => undefined);
    html = await page.content();
    frameUrls = page.frames().map((f) => f.url()).filter((u) => /greenhouse\.io\/.*job_app/.test(u));
  } catch {
    return null; // the company page won't load either
  }
  return tryGreenhouse(page, [...frameUrls, ...greenhouseUrls(greenhouseBoardGuesses(html, url, company).slice(0, 5), id)], tried);
}

/** Opens a page, retrying once after a dropped connection (some career sites cut off automated browsers). */
async function gotoWithRetry(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } catch (error) {
    if (!/net::ERR_|Timeout/i.test(String(error))) throw error;
    await page.waitForTimeout(4_000);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => undefined);
}

export async function openForm(page: Page, site: Site, url: string, company?: string, depth = 0): Promise<SiteForm> {
  if (site === "other" || site === "workday") return openGeneric(page, url, company, depth);
  if (site === "ashby" && !/jobs\.ashbyhq\.com/.test(url)) return openGeneric(page, url, company, depth);
  // A company careers page with ?gh_jid= embeds a Greenhouse form, often late or behind buttons, and
  // some of those sites refuse automated browsers. Going straight to the Greenhouse form comes first;
  // the company page is only needed when that fails.
  if (site === "greenhouse" && !new URL(url).hostname.endsWith("greenhouse.io")) {
    const direct = await openGreenhouseDirect(page, url, company);
    if (direct) return direct;
  }
  await gotoWithRetry(page, url);

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

const APPLY_BUTTON = /^\s*(apply|apply now|apply for (this )?(job|position|role)|apply online|apply here|start (your )?application|begin application|i'?m interested|submit (your )?(resume|cv))\s*$/i;
const NEXT_BUTTON = /^\s*(next|next step|continue|save (and|&) continue|save (and|&) next|proceed|review( application)?)\s*(›|>|→)?\s*$/i;
const SUBMIT_BUTTON = /^\s*(submit|submit application|submit my application|send|send application|apply|apply now|finish|complete( application)?)\s*$/i;
const CLOSED = /(this|the) (job|position|posting|role) (is )?(no longer|not) (available|accepting|open)|job (has )?(expired|closed)|position has been filled|no longer accepting applications/i;

/** Clicks away a cookie banner that would sit over the form. */
async function dismissCookies(page: Page): Promise<void> {
  const accept = page.getByRole("button", { name: /^\s*(accept( all)?( cookies)?|allow all|i agree|got it|ok)\s*$/i }).first();
  if (await accept.isVisible().catch(() => false)) await accept.click({ timeout: 3_000 }).catch(() => undefined);
}

/** A sign-in or create-account wall with no application form: the applier never makes accounts for you. */
async function accountWall(page: Page): Promise<boolean> {
  const password = await page.locator("input[type='password']:visible").count().catch(() => 0);
  if (password > 0) return true;
  const text = await page.locator("body").innerText().catch(() => "");
  return /(sign|log) in to (apply|continue)|create (an )?account to (apply|continue)|please (sign|log) in/i.test(text);
}

/**
 * Any other career site: open the posting, click its Apply button (following a new tab
 * or a hand-off to Greenhouse, Lever or Ashby), until an application form shows.
 */
async function openGeneric(page: Page, url: string, company: string | undefined, depth: number): Promise<SiteForm> {
  await gotoWithRetry(page, url);
  for (let hop = 0; hop < 4; hop++) {
    await dismissCookies(page);
    // Handed off to a site with its own handler?
    const now = identify(page.url());
    if (depth === 0 && now && now.site !== "other" && now.site !== "workday" && hop > 0) return openForm(page, now.site, now.applyUrl, company, depth + 1);
    if (await findApplicationForm(page.mainFrame(), hop === 0 ? 4_000 : 8_000)) return { frame: page.mainFrame(), root: FORM };
    for (const frame of page.frames().slice(1)) if (await findApplicationForm(frame, 1_000)) return { frame, root: FORM };
    if (await accountWall(page)) throw new SiteBlocked("this site needs an account or sign-in to apply; apply by hand");
    if (CLOSED.test(await page.locator("body").innerText().catch(() => ""))) throw new SiteBlocked("the posting says it's closed");

    const apply = page.getByRole("button", { name: APPLY_BUTTON }).or(page.getByRole("link", { name: APPLY_BUTTON })).first();
    if (!(await apply.count())) break;
    const popup = page.context().waitForEvent("page", { timeout: 6_000 }).catch(() => null);
    await apply.click({ timeout: 5_000 }).catch(() => undefined);
    const opened = await popup;
    if (opened) {
      // Apply opened a new tab: continue in this one, so screenshots and the report follow.
      await opened.waitForLoadState("domcontentloaded").catch(() => undefined);
      const target = opened.url();
      await opened.close().catch(() => undefined);
      if (target && target !== "about:blank") await gotoWithRetry(page, target);
    } else {
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      await page.waitForTimeout(1_500);
    }
  }
  if (await accountWall(page)) throw new SiteBlocked("this site needs an account or sign-in to apply; apply by hand");
  throw new Error("Couldn't find the application form on this page (the job may be closed, or the page needs a login).");
}

/** The button that goes to the next page of a multi-page application, when the page has no final submit. */
export async function nextStepButton(form: SiteForm) {
  const scope = form.frame;
  const buttons = scope.getByRole("button", { name: NEXT_BUTTON }).or(scope.locator("input[type='submit'], input[type='button']").filter({ hasText: NEXT_BUTTON }));
  for (let i = 0; i < (await buttons.count()); i++) {
    const button = buttons.nth(i);
    if (await button.isVisible().catch(() => false)) return button;
  }
  return null;
}

/** Goes to the next page of the application and finds its fields. */
export async function goToNextStep(form: SiteForm): Promise<SiteForm | null> {
  const button = await nextStepButton(form);
  if (!button) return null;
  await button.click({ timeout: 5_000 });
  const page = form.frame.page();
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForTimeout(1_500);
  const frame = form.frame.isDetached() ? page.mainFrame() : form.frame;
  return (await findApplicationForm(frame, 10_000)) ? { frame, root: FORM } : { frame, root: "body" };
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
  const known = frame.locator(`${root} button[type='submit'], ${root} input[type='submit'], ${root} button:has-text("Submit application"), ${root} button:has-text("Submit Application"), button#btn-submit`);
  let button = known.first();
  for (let i = 0; i < (await known.count()); i++) {
    const candidate = known.nth(i);
    const text = ((await candidate.innerText().catch(() => "")) || (await candidate.inputValue().catch(() => ""))).trim();
    if ((await candidate.isVisible().catch(() => false)) && !NEXT_BUTTON.test(text)) {
      button = candidate;
      break;
    }
  }
  if (!(await known.count())) button = frame.getByRole("button", { name: SUBMIT_BUTTON }).first();
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
