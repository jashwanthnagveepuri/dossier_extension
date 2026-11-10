import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dataDir, documentName } from "./config.js";
import { short } from "./errors.js";
import { Dossier } from "./dossier/mcp.js";
import { applyOnPage, describeFilled } from "./forms/apply.js";
import { gmailClient, waitForSecurityCode } from "./gmail.js";
import { Ledger } from "./ledger.js";
import { opener, openEnv, run, systemOpener, assistant } from "./run.js";
import { identify, isRepost } from "./select/canonical.js";
import { hardSkip } from "./select/filters.js";
import { createInterface } from "node:readline/promises";
import { aiMayAnswer } from "./forms/answers.js";
import { findSaved, loadSavedAnswers, saveAnswers } from "./saved-answers.js";

const [command, ...args] = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

async function setup() {
  const env = await openEnv({ headed: true });
  try {
    env.log("1/3 Signing in to Dossier's site (for resume PDFs)…");
    await env.pdf.download({ doc: "base" }, dataDir("tmp"), "base.pdf");
    env.log("    ✓ Dossier sign-in works and the base resume PDF downloads");

    env.log("2/3 Connecting to Dossier's connector. Approve the request in the window that opens…");
    const dossier = await Dossier.connect(env.settings.dossier.url, opener(env.context, env.log));
    const profile = await dossier.call<{ name?: string; experience?: { role: string; company: string }[] }>("get_profile");
    env.log(`    ✓ Connected. Profile: ${profile.name ?? "?"}, ${profile.experience?.length ?? 0} roles`);
    await dossier.close();

    if (env.settings.gmail.enabled) {
      env.log("3/3 Connecting Gmail (read-only). Approve it in your normal browser (sign in as the account applications use)…");
      await gmailClient(env.settings.gmail.client_file, systemOpener(env.log));
      env.log("    ✓ Gmail connected");
    } else env.log("3/3 Gmail is off in settings.yaml; skipped");
    env.log("Setup done. Next: npm run try -- <a Greenhouse or Lever job link>");
  } finally {
    await env.close();
  }
}

/** Fills one posting's form with your base resume and stops before submitting. */
async function tryOne(url: string | undefined) {
  if (!url) throw new Error("Give a job link: npm run try -- https://job-boards.greenhouse.io/company/jobs/123");
  const job = identify(url);
  if (!job) throw new Error("That isn't a link.");
  const env = await openEnv({ headed: true });
  try {
    const evidenceDir = dataDir("evidence", `try_${Date.now()}`);
    const resume = await env.pdf.download({ doc: "base" }, evidenceDir, documentName(env.bank, "Resume"));
    const page = await env.context.newPage();
    try {
      // The profile and posting let the AI answer questions the answer bank doesn't cover.
      const dossier = await Dossier.connect(env.settings.dossier.url, opener(env.context, env.log));
      const profile = await dossier.call("get_profile");
      const posting = await dossier.call<{ text: string }>("get_posting", { posting_url: url }).then((p) => p.text).catch(() => "");
      await dossier.close();
      const outcome = await applyOnPage(page, job, { bank: env.bank, ai: env.ai, dryRun: true, evidenceDir, log: env.log, files: { resume }, profile, posting });
      const lines = describeFilled(outcome.filled);
      writeFileSync(join(evidenceDir, "fields.txt"), lines.join("\n"));
      console.log(`\n${job.site} form, ${outcome.outcome === "needs-you" ? "would need you" : "ready to submit"}:\n${lines.join("\n")}`);
      if (outcome.outcome === "needs-you") console.log(`\nWhy it would stop:\n- ${outcome.why.join("\n- ")}`);
      if (outcome.aiAnswers.length) console.log(`\nAI answers (check these):\n\n${outcome.aiAnswers.join("\n\n")}`);
    } catch (error) {
      await page.screenshot({ path: join(evidenceDir, "error.png"), fullPage: true }).catch(() => undefined);
      writeFileSync(join(evidenceDir, "page.html"), await page.content().catch(() => ""));
      console.log(`\nIt stopped with an error: ${short(error)}`);
    }
    console.log(`\nScreenshot and details: ${evidenceDir}`);
    if (!flag("close")) {
      console.log("The browser stays open so you can look at the form. Press Ctrl+C to close.");
      await new Promise(() => undefined);
    }
  } finally {
    await env.close();
  }
}

type Env = Awaited<ReturnType<typeof openEnv>>;
/** Security codes already typed in this command, across all the jobs it finishes: never reused. */
const USED_CODES = new Set<string>();
type LedgerEntry = ReturnType<Ledger["all"]>[number];

/** Applications that stopped for you and haven't been sent since, newest first. */
function waitingOnYou(ledger: Ledger): LedgerEntry[] {
  const all = ledger.all();
  const latest = new Map<string, LedgerEntry>();
  for (const entry of all) if (entry.by === "applier" && entry.applicationId && (entry.outcome === "needs-you" || entry.outcome === "submitted" || entry.outcome === "failed")) latest.set(entry.key, entry);
  // Stopped for you, or failed with a Dossier draft left behind: both can be finished.
  return [...latest.values()].filter((entry) => entry.outcome === "needs-you" || entry.outcome === "failed").reverse();
}

/** Fills and submits a stopped application from its existing Dossier draft (no second draft). */
async function finish(env: Env, entry: LedgerEntry, dryRun: boolean): Promise<"submitted" | "needs-you" | "dry-run" | "skipped"> {
  const job = identify(entry.url ?? "");
  if (!job || !entry.applicationId) throw new Error(`Can't read the job link ${entry.url}`);
  env.log(`Finishing ${entry.company}: ${entry.title}`);
  const dossier = await Dossier.connect(env.settings.dossier.url, opener(env.context, env.log));
  try {
    const profile = await dossier.call("get_profile");
    const posting = await dossier.call<{ text: string }>("get_posting", { posting_url: entry.url }).then((p) => p.text).catch(() => "");
    const gmail = env.settings.gmail.enabled ? await gmailClient(env.settings.gmail.client_file, systemOpener(env.log)) : null;
    const evidenceDir = dataDir("evidence", `retry_${Date.now()}`);
    const resume = await env.pdf.download({ doc: "resume", application: entry.applicationId }, evidenceDir, documentName(env.bank, "Resume")).catch((error) => {
      if (!/no longer exists/i.test(String(error))) throw error;
      // You deleted it in Dossier: stop offering it.
      env.ledger.add({ key: entry.key, company: entry.company, title: entry.title, by: "applier", outcome: "skipped", reason: "deleted in Dossier", applicationId: entry.applicationId, url: entry.url });
      console.log("  Deleted in Dossier, so it won't come up again.");
      return null;
    });
    if (!resume) return "skipped";
    const page = await env.context.newPage();
    const outcome = await applyOnPage(page, job, {
      assist: dryRun ? undefined : assistant(env.settings),
      bank: env.bank,
      ai: env.ai,
      dryRun,
      evidenceDir,
      log: env.log,
      profile,
      posting,
      applicationId: entry.applicationId,
      company: entry.company,
      getCode: gmail ? (since) => waitForSecurityCode(gmail, since, { company: entry.company, used: USED_CODES }) : undefined,
      files: { resume, cover_letter: () => env.pdf.download({ doc: "letter", application: entry.applicationId! }, evidenceDir, documentName(env.bank, "Cover_Letter")) },
    });
    writeFileSync(join(evidenceDir, "fields.txt"), describeFilled(outcome.filled).join("\n"));
    await page.close();
    if (outcome.outcome === "submitted") {
      await dossier.call("set_application_status", { id: entry.applicationId, status: "SENT" });
      env.ledger.add({ key: entry.key, company: entry.company, title: entry.title, by: "applier", outcome: "submitted", applicationId: entry.applicationId, url: entry.url });
      console.log(`  ✅ Submitted. Dossier shows it as Sent.`);
      return "submitted";
    }
    if (outcome.outcome === "needs-you") {
      env.ledger.add({ key: entry.key, company: entry.company, title: entry.title, by: "applier", outcome: "needs-you", reason: outcome.why.join("; "), questions: outcome.questions, applicationId: entry.applicationId, url: entry.url });
      console.log(`  ✋ Still needs you:\n  - ${outcome.why.join("\n  - ")}`);
      return "needs-you";
    }
    console.log("  🧪 Filled, not submitted (dry run).");
    return "dry-run";
  } finally {
    await dossier.close();
  }
}

async function retry(target: string | undefined) {
  const env = await openEnv({ headed: true });
  try {
    if (flag("all")) {
      const all = waitingOnYou(env.ledger);
      if (!all.length) return console.log("Nothing is waiting on you.");
      console.log(`Retrying ${all.length} stopped application(s)…`);
      const results: Record<string, number> = {};
      for (const entry of all) {
        const result = await finish(env, entry, flag("dry-run")).catch(async (error) => {
          console.log(`  ⚠️ ${entry.company}: ${short(error)}`);
          if (/no longer exists/i.test(String(error))) {
            // You deleted it in Dossier: stop retrying it.
            env.ledger.add({ key: entry.key, company: entry.company, title: entry.title, by: "applier", outcome: "skipped", reason: "deleted in Dossier", applicationId: entry.applicationId, url: entry.url });
            console.log("    (deleted in Dossier, so it won't be retried again)");
            return "skipped";
          }
          const last = env.context.pages().slice(-1)[0];
          const shot = join(dataDir("evidence", `error_${Date.now()}`), "error.png");
          if (last) await last.screenshot({ path: shot, fullPage: true }).then(() => console.log(`    screenshot: ${shot}`)).catch(() => undefined);
          return "failed";
        });
        results[result] = (results[result] ?? 0) + 1;
      }
      console.log(`\nDone: ${JSON.stringify(results)}. Anything still waiting: npm run pending`);
      return;
    }
    const entry = waitingOnYou(env.ledger).find((e) => !target || e.applicationId === target || e.url === target);
    if (!entry) throw new Error(target ? `No stopped application matches ${target}. Run npm run pending to see them.` : "No stopped applications to retry.");
    await finish(env, entry, flag("dry-run"));
  } finally {
    await env.close();
  }
}

/** Asks you each open question in the terminal, saves your answers, then finishes those applications. */
async function pending() {
  const ledger = new Ledger();
  const waiting = waitingOnYou(ledger);
  if (!waiting.length) return console.log("Nothing is waiting on you.");
  const saved = loadSavedAnswers();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ready: LedgerEntry[] = [];
  console.log(`${waiting.length} application(s) are waiting on you. Press Enter on a question to skip that application for now.\nType ai as your answer to let the AI answer that question from your profile.\n`);
  for (const entry of waiting) {
    console.log(`── ${entry.company}: ${entry.title}\n   ${entry.url}`);
    // Older entries only have the reason text: "<question>: <why>; <question>: <why>".
    const asked = entry.questions?.length
      ? entry.questions
      : (entry.reason ?? "").split("; ").filter((part) => /not in the answer bank|AI couldn't answer|no matching option|couldn't fill/.test(part)).map((part) => ({ label: part.split(/: (?=question not in|"|no matching|couldn't)/)[0].trim(), options: [] as string[] })).filter((q) => q.label);
    const questions = asked.filter((q) => !findSaved(saved, q.label, entry.applicationId));
    if (!asked.length) {
      console.log(`   Reason: ${entry.reason ? short(entry.reason) : "unknown"}`);
      const again = (await rl.question("   Nothing to answer here. Try submitting it again? (y/N) ")).trim().toLowerCase();
      if (again.startsWith("y")) ready.push(entry);
      continue;
    }
    let skipped = false;
    for (const q of questions) {
      console.log(`\n   Q: ${q.label}`);
      if (q.options.length) console.log(`   Options: ${q.options.join(" | ")}`);
      const answer = (await rl.question("   Your answer: ")).trim();
      if (!answer) {
        skipped = true;
        break;
      }
      const legal = !aiMayAnswer(null, { id: "", kind: "text", label: q.label, required: true, options: [] });
      const keep = (await rl.question(`   Use this answer for future applications too? ${legal ? "(y/N)" : "(Y/n)"} `)).trim().toLowerCase();
      const forever = legal ? keep.startsWith("y") : !keep.startsWith("n");
      saved.push({ question: q.label, answer, ...(forever ? {} : { only_for: entry.applicationId }) });
    }
    if (!skipped) ready.push(entry);
    console.log("");
  }
  rl.close();
  saveAnswers(saved);
  if (!ready.length) return console.log("Nothing to finish now. Your answers are saved in config/my-answers.yaml.");
  console.log(`Finishing ${ready.length} application(s)…`);
  const env = await openEnv();
  try {
    for (const entry of ready) await finish(env, entry, false).catch((error) => console.log(`  ⚠️ ${entry.company}: ${short(error)}`));
  } finally {
    await env.close();
  }
}

type DossierRow = { id: string; title?: string; company?: string; role?: string; status: string; updated: string; posting?: string };

/**
 * Lines Dossier up with the ledger: every Draft in Dossier gets explained, submitted ones are moved to Sent,
 * and drafts the applier never finished (dry runs, try runs) are queued for npm run retry -- --all.
 */
async function sync() {
  const env = await openEnv({ headed: true });
  const dossier = await Dossier.connect(env.settings.dossier.url, opener(env.context, env.log));
  try {
    const drafts = await dossier.call<DossierRow[]>("list_applications", { status: "DRAFT", limit: 100 });
    const latest = new Map<string, LedgerEntry>();
    for (const entry of env.ledger.all()) if (entry.applicationId) latest.set(entry.applicationId, entry);
    console.log(`Dossier has ${drafts.length} draft(s):\n`);
    const tally: Record<string, number> = {};
    const manual: string[] = [];
    const note = (kind: string, row: DossierRow, detail: string) => {
      tally[kind] = (tally[kind] ?? 0) + 1;
      console.log(`  ${kind.padEnd(12)} ${(row.company ?? "?").slice(0, 24).padEnd(24)} ${(row.role ?? row.title ?? "").slice(0, 50).padEnd(50)} ${detail}`);
    };
    for (const row of drafts) {
      const entry = latest.get(row.id);
      if (entry?.outcome === "submitted") {
        await dossier.call("set_application_status", { id: row.id, status: "SENT" });
        note("fixed", row, "was submitted; now marked Sent");
        continue;
      }
      if (entry?.outcome === "needs-you" || entry?.outcome === "failed") {
        note("waiting", row, `npm run retry -- --all (${(entry.reason ?? "").slice(0, 60)})`);
        continue;
      }
      if (entry?.outcome === "skipped") {
        note("skipped", row, `${entry.reason ?? ""}; safe to delete in Dossier`);
        continue;
      }
      // Not in the ledger: a dry run, a try run, or a draft made in Dossier itself.
      const job = row.posting ? identify(row.posting) : null;
      if (!job || !env.settings.phase.sites.includes(job.site as never) || isRepost(job.applyUrl)) {
        const host = row.posting ? new URL(row.posting).hostname.replace(/^www\./, "") : "";
        note("manual", row, !row.posting ? "no job link; apply by hand or delete" : isRepost(row.posting) ? `${host}: a job board's repost; apply on the employer's site or delete` : `${host}: turned off in settings.yaml (phase.sites)`);
        manual.push(`| ${row.company ?? ""} | ${row.role ?? row.title ?? ""} | ${host} | ${row.posting ? `[open](${row.posting})` : ""} |`);
        continue;
      }
      const company = row.company ?? "";
      const title = row.role ?? row.title ?? "";
      const text = await dossier.call<{ text: string }>("get_posting", { posting_url: row.posting }).then((p) => p.text).catch(() => "");
      const skip = hardSkip({ title, company, text }, env.bank);
      if (skip) {
        env.ledger.add({ key: job.key, company, title, by: "applier", outcome: "skipped", reason: skip, applicationId: row.id, url: row.posting });
        note("filtered", row, `${skip}; safe to delete in Dossier`);
        continue;
      }
      if (env.ledger.appliedTo(job.key, company, title)) {
        note("duplicate", row, "already applied to this job; safe to delete in Dossier");
        continue;
      }
      env.ledger.add({ key: job.key, company, title, by: "applier", outcome: "failed", reason: "Dossier draft never submitted (dry run or try run)", applicationId: row.id, url: row.posting });
      note("queued", row, "will be applied by npm run retry -- --all");
    }
    if (manual.length) {
      const file = join(dataDir("reports"), `manual-${new Date().toISOString().slice(0, 10)}.md`);
      writeFileSync(file, `# Drafts to apply to by hand\n\n| Company | Role | Site | Link |\n| --- | --- | --- | --- |\n${manual.join("\n")}\n`);
      console.log(`\nLinks for the ${manual.length} manual draft(s): ${file}`);
    }
    console.log(`\nSummary: ${JSON.stringify(tally)}`);
    if (tally.queued || tally.waiting) console.log("Next: npm run retry -- --all");
  } finally {
    await dossier.close();
    await env.close();
  }
}

function report() {
  const day = value("date") ?? new Date().toISOString().slice(0, 10);
  const file = join(dataDir("reports"), `${day}.md`);
  console.log(existsSync(file) ? readFileSync(file, "utf8") : `No report for ${day}.`);
  const counts: Record<string, number> = {};
  for (const entry of new Ledger().all()) counts[`${entry.by}/${entry.outcome}`] = (counts[`${entry.by}/${entry.outcome}`] ?? 0) + 1;
  console.log(`\nAll time: ${JSON.stringify(counts)}`);
}

async function main() {
  switch (command) {
    case "setup":
      return setup();
    case "run":
      return run({ dryRun: flag("dry-run"), limit: value("limit") ? Number(value("limit")) : undefined });
    case "try":
      return tryOne(args.find((arg) => !arg.startsWith("--")));
    case "report":
      return report();
    case "retry":
      return retry(args.find((arg) => !arg.startsWith("--")));
    case "pending":
      return pending();
    case "sync":
      return sync();
    default:
      console.log("Commands: setup | run [--dry-run] [--limit N] | try <job link> | retry [application id or job link | --all] [--dry-run] | pending | sync | report [--date YYYY-MM-DD]");
  }
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
