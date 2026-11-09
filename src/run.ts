import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chromium, type BrowserContext } from "playwright";

import { Ai, type PostingScore } from "./ai.js";
import { dataDir, loadAnswerBank, loadEnv, loadSettings, secret, type AnswerBank, type Settings, documentName } from "./config.js";
import { Dossier, type DraftStarted, type DraftState, type PostingText, type SearchResult } from "./dossier/mcp.js";
import { DossierPdf } from "./dossier/pdf.js";
import { applyOnPage, describeFilled } from "./forms/apply.js";
import { PAGE_SHIM } from "./forms/page.js";
import { gmailClient, syncConfirmations, waitForSecurityCode } from "./gmail.js";
import { Ledger } from "./ledger.js";
import { identify, type JobIdentity } from "./select/canonical.js";
import { hardSkip, pickToday } from "./select/filters.js";

/** Scoring costs a Claude call each; this bounds one run. */
const MAX_SCORED_PER_RUN = 60;

export type Env = {
  bank: AnswerBank;
  settings: Settings;
  ledger: Ledger;
  context: BrowserContext;
  pdf: DossierPdf;
  ai: Ai;
  log: (line: string) => void;
  close: () => Promise<void>;
};

export async function openEnv(options: { headed?: boolean } = {}): Promise<Env> {
  loadEnv();
  const bank = loadAnswerBank();
  const settings = loadSettings();
  const day = new Date().toISOString().slice(0, 10);
  const logFile = join(dataDir("logs"), `${day}.log`);
  const log = (line: string) => {
    console.log(line);
    appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  };
  const context = await chromium.launchPersistentContext(dataDir("browser"), {
    headless: options.headed ? false : settings.browser.headless,
    slowMo: settings.browser.slow_mo_ms,
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
  await context.addInitScript({ content: PAGE_SHIM });
  context.setDefaultTimeout(10_000); // a stuck field fails in 10s instead of 30s
  const pdf = new DossierPdf(context, settings.dossier.url, secret(settings.dossier.password_env));
  const ai = new Ai(secret(settings.anthropic.api_key_env), settings.anthropic.model);
  return { bank, settings, ledger: new Ledger(), context, pdf, ai, log, close: () => context.close() };
}

/**
 * Opens a link in your normal browser. Google refuses sign-in from browsers
 * that automation controls ("This browser or app may not be secure"), so Gmail
 * sign-in has to happen there. The link is printed too, in case nothing opens.
 */
export function systemOpener(log: (line: string) => void) {
  return (url: string) => {
    log(`Opening in your browser (if nothing opens, paste this link into your browser):\n${url}`);
    // rundll32's URL handler opens the default browser on Windows and keeps "&" in the link intact.
    const [command, args] =
      process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    try {
      spawn(command as string, args as string[], { detached: true, stdio: "ignore" }).unref();
    } catch {
      // The printed link is enough.
    }
  };
}

/** Opens a link in the applier's own browser window (where you're signed in to Dossier). */
export function opener(context: BrowserContext, log: (line: string) => void) {
  return (url: string) => {
    log(`Opening a sign-in page: ${url}`);
    void context.newPage().then((page) => page.goto(url));
  };
}

type Candidate = {
  searchId: string;
  number: number;
  title: string;
  company: string;
  job: JobIdentity;
  score?: PostingScore;
};

/** One daily run: inbox → search → filter → score → pick → draft → apply → record. */
export async function run(options: { dryRun: boolean; limit?: number }): Promise<void> {
  const env = await openEnv();
  const { bank, settings, ledger, log } = env;
  const started = new Date();
  const report: string[] = [];
  try {
    log(`Run started${options.dryRun ? " (dry run: nothing is submitted)" : ""}`);
    let gmail: Awaited<ReturnType<typeof gmailClient>> | null = null;
    if (settings.gmail.enabled) {
      gmail = await gmailClient(settings.gmail.client_file, systemOpener(log));
      const added = await syncConfirmations(gmail, ledger, settings.gmail.lookback_days);
      log(`Inbox: ${added} new confirmation emails recorded`);
    }

    // Sign in to Dossier's site first, so the connector's consent page (first run only) opens signed in.
    await env.pdf.download({ doc: "base" }, dataDir("tmp"), "base.pdf");
    const dossier = await Dossier.connect(settings.dossier.url, opener(env.context, log));
    const profile = await dossier.call("get_profile");

    // ---- Find ----
    const candidates: Candidate[] = [];
    const seenKeys = new Set<string>();
    const skippedSites: Record<string, number> = {};
    for (const keywords of settings.search.queries) {
      const result = await dossier.call<SearchResult>("search_jobs", { keywords, place: "", country: settings.search.country, posted_within: settings.search.posted_within }).catch((error) => {
        log(`Search "${keywords}" failed: ${String(error).slice(0, 200)}`);
        return null;
      });
      if (!result) continue;
      for (const posting of result.postings) {
        const job = posting.url ? identify(posting.url) : null;
        if (!job) continue;
        if (!settings.phase.sites.includes(job.site)) {
          const where = job.site === "other" ? new URL(job.applyUrl).hostname.replace(/^www\./, "") : job.site;
          skippedSites[where] = (skippedSites[where] ?? 0) + 1;
          continue;
        }
        const sameTitle = `${posting.company}|${posting.title}`.toLowerCase();
        if (seenKeys.has(sameTitle)) continue;
        seenKeys.add(sameTitle);
        if (seenKeys.has(job.key) || posting.applied || ledger.seen(job.key) || ledger.appliedTo(job.key, posting.company, posting.title)) continue;
        seenKeys.add(job.key);
        candidates.push({ searchId: result.search_id, number: posting.number, title: posting.title, company: posting.company, job });
      }
    }
    const otherSites = Object.entries(skippedSites).sort((a, b) => b[1] - a[1]);
    log(`Found ${candidates.length} new postings on ${settings.phase.sites.join(" and ")}.`);
    if (otherSites.length) log(`Left for later phases (${otherSites.reduce((sum, [, n]) => sum + n, 0)}): ${otherSites.slice(0, 12).map(([site, n]) => `${site} ${n}`).join(", ")}`);
    log(`Checking and scoring them now (about 5–15 seconds each, nothing shows in the browser yet)…`);

    // ---- Filter and score ----
    const scored: (Candidate & { score: PostingScore; key: string; postingText: string })[] = [];
    const toScore = candidates.slice(0, MAX_SCORED_PER_RUN);
    for (const [index, candidate] of toScore.entries()) {
      const label = `${index + 1}/${toScore.length} ${candidate.company}: ${candidate.title}`.slice(0, 110);
      const posting = await dossier.call<PostingText>("get_posting", { search_id: candidate.searchId, number: candidate.number }).catch(() => null);
      if (!posting) {
        log(`  ${label}: couldn't read the posting`);
        continue;
      }
      const skip = hardSkip({ title: candidate.title, company: candidate.company, text: posting.text }, bank);
      if (skip) {
        log(`  ${label}: skipped (${skip})`);
        ledger.add({ key: candidate.job.key, company: candidate.company, title: candidate.title, by: "applier", outcome: "skipped", reason: skip, url: candidate.job.applyUrl });
        continue;
      }
      const score = await env.ai.score(profile, posting).catch((error) => {
        log(`Scoring failed for ${candidate.company}: ${String(error).slice(0, 160)}`);
        return null;
      });
      if (!score) continue;
      log(`  ${label}: score ${score.score}`);
      await dossier
        .call("save_job_scores", { search_id: candidate.searchId, scores: [{ number: candidate.number, score: score.score, reasons: score.reasons.length ? score.reasons : ["Scored by the applier"], red_flags: score.redFlags }] })
        .catch(() => undefined);
      scored.push({ ...candidate, score, key: candidate.job.key, postingText: posting.text });
    }
    const picks = pickToday(scored.map((item) => ({ ...item, score: item.score.score, detail: item.score })), bank.selection, ledger.countToday()).slice(0, options.limit ?? Infinity);
    const pickedKeys = new Set(picks.map((pick) => pick.key));
    for (const item of scored) {
      // A dry run decides nothing for later: only real runs record what they passed over.
      if (!options.dryRun && !pickedKeys.has(item.key)) ledger.add({ key: item.key, company: item.company, title: item.title, by: "applier", outcome: "skipped", reason: `score ${item.score.score} below today's cut`, url: item.job.applyUrl });
    }
    log(`Scored ${scored.length}; applying to ${picks.length} today (cap ${bank.selection.daily_cap}, ${ledger.countToday()} already today)`);

    // ---- Apply ----
    const usedCodes = new Set<string>(); // security codes already typed this run: never reused
    for (const pick of picks) {
      const title = `${pick.company}: ${pick.title} (score ${pick.score})`;
      log(`→ ${title}`);
      const evidenceDir = dataDir("evidence", `${started.toISOString().slice(0, 10)}_${slug(pick.company)}_${slug(pick.title)}`);
      let applicationId: string | undefined;
      try {
        let resume: string;
        if (options.dryRun) {
          resume = await env.pdf.download({ doc: "base" }, evidenceDir, documentName(bank, "Resume"));
        } else {
          applicationId = await draft(dossier, pick.searchId, pick.number);
          resume = await env.pdf.download({ doc: "resume", application: applicationId }, evidenceDir, documentName(bank, "Resume"));
        }
        const page = await env.context.newPage();
        try {
          const outcome = await applyOnPage(page, pick.job, {
            company: pick.company,
            bank,
            ai: env.ai,
            dryRun: options.dryRun,
            evidenceDir,
            log,
            profile,
            posting: pick.postingText,
            applicationId,
            getCode: gmail ? (since) => waitForSecurityCode(gmail!, since, { company: pick.company, used: usedCodes }) : undefined,
            files: {
              resume,
              cover_letter: applicationId ? () => env.pdf.download({ doc: "letter", application: applicationId! }, evidenceDir, documentName(bank, "Cover_Letter")) : undefined,
            },
          });
          writeFileSync(join(evidenceDir, "fields.txt"), describeFilled(outcome.filled).join("\n"));
          const aiNote = outcome.aiAnswers.length ? `\n   AI answered ${outcome.aiAnswers.length} question(s), see ${join(evidenceDir, "ai-answers.txt")}` : "";
          if (outcome.outcome === "submitted" && applicationId) {
            await dossier.call("set_application_status", { id: applicationId, status: "SENT" });
            ledger.add({ key: pick.key, company: pick.company, title: pick.title, by: "applier", outcome: "submitted", applicationId, url: pick.job.applyUrl });
            report.push(`✅ Submitted: ${title}\n   ${pick.job.applyUrl}${aiNote}`);
          } else if (outcome.outcome === "dry-run") {
            ledger.add({ key: pick.key, company: pick.company, title: pick.title, by: "applier", outcome: "dry-run", url: pick.job.applyUrl });
            report.push(`🧪 Filled, not submitted (dry run): ${title}\n   ${pick.job.applyUrl}\n   evidence: ${evidenceDir}${aiNote}`);
          } else {
            const why = outcome.outcome === "needs-you" ? outcome.why : [];
            ledger.add({ key: pick.key, company: pick.company, title: pick.title, by: "applier", outcome: options.dryRun ? "dry-run" : "needs-you", reason: why.join("; "), questions: outcome.outcome === "needs-you" ? outcome.questions : [], applicationId, url: pick.job.applyUrl });
            report.push(`✋ Needs you: ${title}\n   ${pick.job.applyUrl}\n   ${why.map((line) => `- ${line}`).join("\n   ")}\n   Draft in Dossier: ${applicationId ? `${settings.dossier.url}/applications/${applicationId}\n   To answer and finish it: npm run pending` : "(dry run)"}`);
          }
          log(`  ${report.at(-1)?.split("\n")[0]}`);
        } finally {
          await page.close();
        }
      } catch (error) {
        // A screenshot of where it broke, for diagnosing (every page of this job is still open in the browser context).
        for (const open of env.context.pages().slice(-1)) await open.screenshot({ path: join(evidenceDir, "error.png"), fullPage: true }).catch(() => undefined);
        ledger.add({ key: pick.key, company: pick.company, title: pick.title, by: "applier", outcome: options.dryRun ? "dry-run" : "failed", reason: String(error).slice(0, 300), applicationId, url: pick.job.applyUrl });
        report.push(`⚠️ Failed: ${title}\n   ${String(error).slice(0, 200)}`);
        log(`  failed: ${String(error).slice(0, 200)}`);
      }
    }
    await dossier.close();
  } finally {
    const file = join(dataDir("reports"), `${started.toISOString().slice(0, 10)}.md`);
    appendFileSync(file, `\n## Run at ${started.toLocaleTimeString()}${options.dryRun ? " (dry run)" : ""}\n\n${report.join("\n\n") || "Nothing to apply to."}\n`);
    log(`Report: ${file}`);
    const waiting = report.filter((line) => line.startsWith("✋")).length;
    if (waiting && !options.dryRun) log(`${waiting} application(s) need you. Run: npm run pending`);
    await env.close();
  }
}

/** Has Dossier write the tailored resume and cover letter; returns the application id. */
async function draft(dossier: Dossier, searchId: string, number: number): Promise<string> {
  const started = await dossier.call<DraftStarted>("draft_application", { search_id: searchId, number });
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const state = await dossier.call<DraftState>("check_draft", { draft_id: started.draft_id });
    if (state.status === "done" && state.application_id) return state.application_id;
  }
  throw new Error("Dossier took longer than 6 minutes to draft the application.");
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}
