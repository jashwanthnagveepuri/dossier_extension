import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dataDir } from "./config.js";
import { normalizeCompany } from "./select/filters.js";
import { sameJob } from "./select/canonical.js";

// Everything ever applied to, by anyone: this applier, other application services (seen in the
// inbox), or you. Keyed by the ATS job identity, so a job found again on
// another board is still recognised.

export type LedgerEntry = {
  key: string; // canonical job identity, or "email:{company}:{title}" when only an email is known
  company: string;
  title: string;
  by: "applier" | "inbox";
  outcome: "submitted" | "needs-you" | "skipped" | "failed" | "dry-run";
  reason?: string;
  /** Questions it couldn't answer, for npm run pending. */
  questions?: { label: string; options: string[] }[];
  applicationId?: string;
  url?: string;
  at: string; // ISO time
};

export class Ledger {
  private readonly file = join(dataDir(), "ledger.json");
  private entries: LedgerEntry[];

  constructor() {
    this.entries = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as LedgerEntry[]) : [];
  }

  /** Whether this exact job was already applied to (or is waiting on you). */
  appliedTo(key: string, company: string, title: string): LedgerEntry | undefined {
    const titleKey = normalizeTitle(title);
    const companyKey = normalizeCompany(company);
    return this.entries.find(
      (entry) =>
        (entry.outcome === "submitted" || entry.outcome === "needs-you") &&
        (sameJob(entry.key, key) || (normalizeCompany(entry.company) === companyKey && normalizeTitle(entry.title) === titleKey)),
    );
  }

  /** Whether the applier already looked at this job and decided against it, so it isn't scored again. */
  seen(key: string): boolean {
    return this.entries.some((entry) => entry.outcome !== "dry-run" && sameJob(entry.key, key));
  }

  /** Applications this applier sent or drafted today, which count toward the daily cap. */
  countToday(now = new Date()): number {
    const today = now.toISOString().slice(0, 10);
    // Distinct jobs: a job that stopped and was then retried counts once.
    return new Set(this.entries.filter((entry) => entry.by === "applier" && entry.at.startsWith(today) && (entry.outcome === "submitted" || entry.outcome === "needs-you")).map((entry) => entry.key)).size;
  }

  add(entry: Omit<LedgerEntry, "at">): void {
    this.entries.push({ ...entry, at: new Date().toISOString() });
    writeFileSync(this.file, JSON.stringify(this.entries, null, 2));
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(sr|senior)\b\.?/g, "senior")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
