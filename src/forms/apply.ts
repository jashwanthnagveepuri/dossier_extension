import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "playwright";

import type { Ai } from "../ai.js";
import type { AnswerBank } from "../config.js";
import type { JobIdentity } from "../select/canonical.js";
import { aiMayAnswer, answerFor, matchRule, matcherKeys, type Answer, type Field } from "./answers.js";
import { hasCaptchaChallenge, openForm, submit, submitWithCode } from "./ats.js";
import { checkLegalAnswers } from "./legal-check.js";
import { fill, peekOptions, readFields, type FillResult } from "./page.js";
import { findSaved, loadSavedAnswers, meansLetAi } from "../saved-answers.js";

export type ApplyOutcome =
  | { outcome: "submitted"; filled: FillResult[]; evidence: string[]; aiAnswers: string[] }
  | { outcome: "dry-run"; filled: FillResult[]; evidence: string[]; aiAnswers: string[] }
  | { outcome: "needs-you"; why: string[]; questions: { label: string; options: string[] }[]; filled: FillResult[]; evidence: string[]; aiAnswers: string[] };

/**
 * Fills one application form and, unless it's a dry run, submits it. Stops
 * before submitting whenever a required field couldn't be answered from the
 * answer bank, or a CAPTCHA shows up.
 */
export async function applyOnPage(
  page: Page,
  job: JobIdentity,
  options: {
    bank: AnswerBank;
    ai: Ai | null;
    files: { resume: string; cover_letter?: () => Promise<string> };
    dryRun: boolean;
    evidenceDir: string;
    log: (line: string) => void;
    /** Reads a security code the site emails (Greenhouse does), sent after `since`; null when it can't. */
    getCode?: (since: Date) => Promise<string | null>;
    /** For AI answers to questions the answer bank doesn't cover; without them those questions go to you. */
    profile?: unknown;
    /** The Dossier application this form belongs to, for answers you gave for it only. */
    applicationId?: string;
    company?: string; // helps find the Greenhouse form behind a company careers page
    posting?: string;
  },
): Promise<ApplyOutcome> {
  const { bank, ai, dryRun, evidenceDir, log } = options;
  const form = await openForm(page, job.site, job.applyUrl, options.company);
  const evidence: string[] = [];
  const shot = async (name: string) => {
    const path = join(evidenceDir, `${name}.png`);
    await page.screenshot({ path, fullPage: true }).catch(() => undefined);
    evidence.push(path);
  };

  const filled: FillResult[] = [];
  const saved = loadSavedAnswers();
  const aiAnswers: string[] = [];
  const done = new Set<string>();
  let coverLetter: string | undefined;

  // Two passes: answering some questions reveals follow-up questions.
  for (let pass = 0; pass < 3; pass++) {
    if (pass > 0) await page.waitForTimeout(800); // follow-up questions render a moment after an answer
    const fields = (await readFields(form.frame, form.root)).filter((field) => !done.has(field.id));
    for (const field of fields) {
      done.add(field.id);
      let key = matchRule(field.label);
      if (!key && ai && field.label && (field.required || field.options.length > 0)) {
        key = await ai.matchQuestion(field.label, field.options, matcherKeys()).catch(() => null);
        if (key) log(`  matched "${field.label.slice(0, 60)}" to ${key} with AI`);
      }
      let answer: Answer = answerFor(field, bank, key);
      // Your own answer (npm run pending) wins over everything except files and checkboxes.
      const found = field.kind === "file" ? undefined : findSaved(saved, field.label, options.applicationId);
      // You told the AI to answer this one ("ai" in npm run pending): it may, even for a question it would normally leave to you.
      const letAi = Boolean(found && meansLetAi(found.answer));
      const mine = letAi ? undefined : found;
      if (mine) answer = ["select", "radio", "checkboxes", "combobox"].includes(field.kind) ? { kind: "choice", prefer: [mine.answer.toLowerCase()] } : field.kind === "checkbox" ? (/^(y|yes|true|agree)/i.test(mine.answer) ? { kind: "check" } : { kind: "skip" }) : { kind: "text", value: mine.answer };
      const canAi = Boolean(!mine && ai && options.profile && bank.ai_answers.enabled && field.label && (letAi || aiMayAnswer(key, field)));
      const askAi = () => answerWithAi(form.frame, field, ai!, options.profile, options.posting ?? "", bank, aiAnswers, log);
      // Optional questions the bank doesn't know get answered too, except long free-text boxes (no filler under your name).
      const optionalUnknown = answer.kind === "skip" && key === null && field.kind !== "textarea";
      if (canAi && (letAi || answer.kind === "needs_you" || optionalUnknown)) answer = await askAi();
      if (answer.kind === "needs_you" && !field.required) answer = { kind: "skip" };
      if (answer.kind === "file" && answer.which === "cover_letter" && !coverLetter && options.files.cover_letter) {
        try {
          coverLetter = await options.files.cover_letter();
        } catch (error) {
          // No letter from Dossier: an optional upload stays blank, a required one goes to you.
          log(`  ! cover letter download failed: ${(error as Error).message}`);
          answer = field.required ? { kind: "needs_you", why: "cover letter couldn't be downloaded from Dossier" } : { kind: "skip" };
        }
      }
      let result = await fill(form.frame, field, answer, { resume: options.files.resume, cover_letter: coverLetter });
      // The bank's answer didn't match any option (e.g. "Yes, I will require sponsorship"): let the AI pick the matching one.
      if (!result.ok && canAi && answer.kind === "choice") {
        const retry = await askAi();
        if (retry.kind !== "needs_you") result = await fill(form.frame, field, retry, { resume: options.files.resume, cover_letter: coverLetter });
        else if (!field.required) result = { field, ok: true, detail: "left blank" };
      }
      filled.push(result);
      if (!result.ok && field.required) log(`  ✗ ${field.label.slice(0, 70)}: ${result.detail}`);
    }
    if (fields.length === 0) break;
  }

  const open = filled.filter((result) => !result.ok && result.field.required);
  const questions = open.filter((result) => result.field.label).map((result) => ({ label: result.field.label, options: result.field.options.slice(0, 30) }));
  const blocking = open.map((result) => `${result.field.label.slice(0, 100)}: ${result.detail}`);
  if (!filled.some((result) => result.ok && result.field.kind === "file")) blocking.push("no resume upload field was filled");
  if (await hasCaptchaChallenge(form.frame)) blocking.push("a CAPTCHA is on the page");
  // Independent last check: what the page shows for every legal question must match your answer bank.
  const legal = await checkLegalAnswers(form.frame, filled, bank);
  if (legal.length) {
    blocking.push(...legal);
    legal.forEach((line) => log(`  ✗ ${line}`));
  }

  if (aiAnswers.length) writeFileSync(join(evidenceDir, "ai-answers.txt"), aiAnswers.join("\n\n"));
  await shot("filled");
  if (blocking.length) return { outcome: "needs-you", why: blocking, questions, filled, evidence, aiAnswers };
  if (dryRun) return { outcome: "dry-run", filled, evidence, aiAnswers };

  // Only code emails sent after this click count (5 s allowance for clock differences).
  const clickedAt = new Date(Date.now() - 5_000);
  let sent = await submit(form);
  for (let attempt = 1; !sent.ok && sent.needsCode && attempt <= 3; attempt++) {
    const code = options.getCode ? await options.getCode(clickedAt).catch(() => null) : null;
    if (!code) {
      sent = { ok: false, why: options.getCode ? (attempt === 1 ? "the security code email didn't arrive within 3 minutes" : "the site rejected the security code, and no other code email matched this job") : "the site emailed a security code, and Gmail is off in settings.yaml" };
      break;
    }
    log(`  entered the emailed security code${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
    sent = await submitWithCode(form, code);
  }
  await shot("after-submit");
  return sent.ok ? { outcome: "submitted", filled, evidence, aiAnswers } : { outcome: "needs-you", why: [sent.why], questions: [], filled, evidence, aiAnswers };
}

/** Asks the AI for an answer from the profile; anything it can't back stays with you. */
async function answerWithAi(
  frame: import("playwright").Frame,
  field: Field,
  ai: Ai,
  profile: unknown,
  posting: string,
  bank: AnswerBank,
  record: string[],
  log: (line: string) => void,
): Promise<Answer> {
  const isChoice = ["select", "radio", "checkboxes", "combobox"].includes(field.kind);
  const options = isChoice ? await peekOptions(frame, field).catch(() => [] as string[]) : [];
  if (isChoice && options.length === 0) return { kind: "needs_you", why: `no options to choose from for "${field.label.slice(0, 80)}"` };
  const result = await ai
    .answerQuestion({ profile, facts: bankFacts(bank), posting, question: field.label, kind: isChoice ? "choice" : field.kind === "textarea" ? "textarea" : "text", options, maxWords: bank.ai_answers.max_words })
    .catch((error) => ({ decision: "needs_you" as const, basis: `AI error: ${String(error).slice(0, 100)}` }));
  if (result.decision !== "answer") {
    return { kind: "needs_you", why: `"${field.label.slice(0, 100)}" (AI couldn't answer from your profile${result.basis ? `: ${result.basis.slice(0, 120)}` : ""})` };
  }
  record.push(`Q: ${field.label}\nA: ${result.value}\nWhy: ${result.basis}`);
  log(`  AI answered "${field.label.slice(0, 60)}": ${result.value.slice(0, 80)}`);
  return isChoice ? { kind: "choice", prefer: [result.value.toLowerCase()] } : { kind: "text", value: result.value };
}

/** What the AI may use besides the profile: your stated answers (nothing the "only you" list covers). */
function bankFacts(bank: AnswerBank) {
  return {
    work_authorization: { authorized_to_work_in_us: bank.work_authorization.authorized_to_work_in_us, requires_sponsorship_now_or_future: bank.work_authorization.requires_sponsorship_now_or_future, status: bank.work_authorization.current_status_text },
    location: `${bank.identity.address.city}, ${bank.identity.address.state}, ${bank.identity.address.country}`,
    compensation: bank.compensation,
    logistics: bank.logistics,
    background: bank.background,
    voluntary_self_identification: bank.voluntary_self_identification,
  };
}

/** A short line per field, for the report. */
export function describeFilled(filled: FillResult[]): string[] {
  return filled
    .filter((result) => result.field.label)
    .map((result) => `${result.ok ? "✓" : result.field.required ? "✗" : "·"} ${result.field.label.slice(0, 80)}${result.detail ? ` (${result.detail.slice(0, 80)})` : ""}`);
}

export type { Field };
