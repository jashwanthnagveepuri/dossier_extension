/**
 * Stops your personal details and secrets from reaching git.
 *
 *   --staged  before every commit (the pre-commit hook): the files you're committing
 *   --push    before every push (the pre-push hook): every commit being pushed,
 *             including its author, committer and message
 *   --all     the whole history (CI, or by hand: npm run check-private)
 *
 * What counts as personal comes from YOUR config/answer-bank.yaml (git-ignored),
 * so nobody has to write their details into the repo to protect them: names,
 * email, phone, street, ZIP, city, profile links, current and past employers,
 * school. Add anything else, one per line, to config/private-terms.txt (also
 * git-ignored). Known secret formats (API keys, tokens, private keys) are
 * always checked, for everyone.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "yaml";

const ROOT = join(import.meta.dirname, "..");
const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/** Files that must never be committed, whatever they contain. */
const NEVER_COMMIT = [
  /^config\/answer-bank\.yaml$/,
  /^config\/answer-bank\.(?!example\.yaml$).*\.ya?ml$/,
  /^config\/my-answers\.yaml$/,
  /^config\/private-terms\.txt$/,
  /^config\/google-oauth-client\.json$/,
  /(^|\/)\.env$/,
  /^data\//,
  /\.bundle$/,
  /\.pdf$/i,
];

const SECRETS: [string, RegExp][] = [
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/],
  ["Google OAuth client secret", /GOCSPX-[0-9A-Za-z_-]{20,}/],
  ["Google OAuth client ID", /\b\d{9,}-[a-z0-9]{32}\.apps\.googleusercontent\.com/],
  ["Anthropic API key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI API key", /\bsk-(proj-)?[A-Za-z0-9]{32,}/],
  ["GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[abpors]-[A-Za-z0-9-]{10,}/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["password hash", /\$argon2(id|i|d)\$/],
  ["reCAPTCHA site key", /\b6L[0-9A-Za-z_-]{38}\b/],
];

/** Your details, read from your own (git-ignored) files. */
function personalTerms(): string[] {
  const terms: string[] = [];
  const bankFile = join(ROOT, "config/answer-bank.yaml");
  if (existsSync(bankFile)) {
    const bank = parse(readFileSync(bankFile, "utf8")) ?? {};
    const id = bank.identity ?? {};
    const address = id.address ?? {};
    const handle = (url?: string) => url?.replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");
    terms.push(
      ...String(id.legal_first_name ?? "").split(/\s+/),
      ...String(id.legal_last_name ?? "").split(/\s+/),
      id.preferred_name,
      id.email,
      String(id.email ?? "").split("@")[0],
      id.phone,
      String(id.phone ?? "").replace(/\D/g, ""),
      address.street,
      address.postal_code,
      address.city,
      handle(id.linkedin),
      handle(id.github),
      handle(id.portfolio),
      handle(id.other_website),
      bank.background?.current_company,
      bank.background?.school,
      ...(bank.do_not_apply?.past_employers ?? []),
    );
  }
  const extra = join(ROOT, "config/private-terms.txt");
  if (existsSync(extra)) terms.push(...readFileSync(extra, "utf8").split(/\r?\n/));
  // The made-up example person is public on purpose.
  const example = new Set(["alex", "rivera", "example bank", "example insurance co", "state university", "springfield", "62701", "100 main street"]);
  return [...new Set(terms.map((t) => String(t ?? "").trim()).filter((t) => t.length >= 4 && !example.has(t.toLowerCase())))];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mask = (s: string) => (s.length <= 4 ? "****" : `${s.slice(0, 2)}${"*".repeat(Math.min(s.length - 2, 8))}`);

type Problem = { where: string; what: string };

function scanText(text: string, where: string, terms: RegExp[], termNames: string[], problems: Problem[]) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const [name, pattern] of SECRETS) if (pattern.test(line)) problems.push({ where: `${where}:${i + 1}`, what: name });
    terms.forEach((pattern, t) => {
      if (pattern.test(line)) problems.push({ where: `${where}:${i + 1}`, what: `your detail "${mask(termNames[t])}"` });
    });
  });
}

function checkPath(path: string, where: string, problems: Problem[]) {
  if (NEVER_COMMIT.some((p) => p.test(path))) problems.push({ where, what: `${path} must never be committed (it's personal or secret)` });
}

/** Commits about to be pushed, from the pre-push hook's input. */
function pushedCommits(): string[] {
  let input = "";
  try {
    input = readFileSync(0, "utf8");
  } catch {
    // no input: nothing to push
  }
  const commits = new Set<string>();
  for (const line of input.split(/\r?\n/).filter(Boolean)) {
    const [, localSha, , remoteSha] = line.split(/\s+/);
    if (!localSha || /^0+$/.test(localSha)) continue; // a branch being deleted
    const range = /^0+$/.test(remoteSha) ? [localSha, "--not", "--remotes"] : [`${remoteSha}..${localSha}`];
    for (const c of git("rev-list", ...range).split("\n").filter(Boolean)) commits.add(c);
  }
  return [...commits];
}

function main() {
  const mode = process.argv[2] ?? "--all";
  const names = personalTerms();
  const terms = names.map((t) => new RegExp(`(^|[^A-Za-z0-9])${escape(t)}($|[^A-Za-z0-9])`, "i"));
  const problems: Problem[] = [];

  if (mode === "--staged") {
    const files = git("diff", "--cached", "--name-only", "--diff-filter=ACMR").split("\n").filter(Boolean);
    for (const file of files) {
      checkPath(file, file, problems);
      scanText(git("show", `:${file}`), file, terms, names, problems);
    }
    const who = `${git("config", "user.name").trim()} ${git("config", "user.email").trim()}`;
    scanText(who, "your git user.name / user.email (the commit's author)", terms, names, problems);
  } else {
    const commits = mode === "--push" ? pushedCommits() : git("rev-list", "--all").split("\n").filter(Boolean);
    for (const commit of commits) {
      const short = commit.slice(0, 7);
      scanText(git("show", "-s", "--format=%an <%ae>%n%cn <%ce>%n%B", commit), `commit ${short} (author, committer, message)`, terms, names, problems);
      for (const file of git("show", "--format=", "--name-only", "--diff-filter=ACMR", commit).split("\n").filter(Boolean)) {
        checkPath(file, `commit ${short}: ${file}`, problems);
        const added = git("show", "--format=", "-U0", commit, "--", file)
          .split("\n")
          .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
          .map((l) => l.slice(1))
          .join("\n");
        scanText(added, `commit ${short}: ${file}`, terms, names, problems);
      }
    }
  }

  const unique = [...new Map(problems.map((p) => [`${p.where}|${p.what}`, p])).values()];
  if (unique.length === 0) {
    console.log(`check-private: OK (${names.length} personal terms and ${SECRETS.length} secret formats checked).`);
    return;
  }
  console.error("\ncheck-private: STOPPED. Personal details or secrets would reach git:\n");
  for (const p of unique.slice(0, 50)) console.error(`  ${p.where}  →  ${p.what}`);
  if (unique.length > 50) console.error(`  …and ${unique.length - 50} more`);
  console.error(
    mode === "--push"
      ? "\nFix the commits (amend or rewrite them) and push again. Nothing was pushed."
      : "\nRemove them and try again. Nothing was committed.",
  );
  process.exit(1);
}

main();
