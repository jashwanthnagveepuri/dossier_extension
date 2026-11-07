import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { OAuth2Client } from "google-auth-library";

import { dataDir, ROOT } from "./config.js";
import type { Ledger } from "./ledger.js";

// Reads application confirmation emails, whoever applied (this applier,
// other application services, or you), so the same job is never applied to twice. Read-only
// Gmail access; nothing is sent or changed.

const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/** Confirmation emails from the big ATSs, and the usual subject lines. */
const QUERY =
  '(from:(greenhouse.io OR greenhouse-mail.io OR hire.lever.co OR lever.co OR myworkday.com OR workday.com OR ashbyhq.com OR icims.com OR smartrecruiters.com OR jobvite.com) OR subject:("thank you for applying" OR "application received" OR "we received your application" OR "your application to" OR "thanks for applying"))';

export async function gmailClient(clientFile: string, openUrl: (url: string) => void): Promise<OAuth2Client> {
  const path = join(ROOT, clientFile);
  if (!existsSync(path)) throw new Error(`${clientFile} is missing. Download a Google OAuth "Desktop app" client JSON there (see README).`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as { installed?: { client_id: string; client_secret: string }; web?: { client_id: string; client_secret: string } };
  const keys = raw.installed ?? raw.web;
  if (!keys) throw new Error(`${clientFile} isn't a Google OAuth client file.`);
  const client = new OAuth2Client({ clientId: keys.client_id, clientSecret: keys.client_secret });
  const tokenFile = join(dataDir(), "gmail-token.json");
  client.on("tokens", (tokens) => {
    const previous = existsSync(tokenFile) ? JSON.parse(readFileSync(tokenFile, "utf8")) : {};
    writeFileSync(tokenFile, JSON.stringify({ ...previous, ...tokens }, null, 2), { mode: 0o600 });
  });
  if (existsSync(tokenFile)) {
    client.setCredentials(JSON.parse(readFileSync(tokenFile, "utf8")));
    return client;
  }
  // A free port chosen now (Google allows any local port for desktop apps; Windows and Docker reserve some fixed ones).
  let redirectUri = "";
  const code = await new Promise<string>((resolveCode, reject) => {
    const keepAlive = setInterval(() => undefined, 1_000); // never exit quietly while waiting for you
    const finish = (error: Error | null, value?: string) => {
      clearInterval(keepAlive);
      clearTimeout(giveUp);
      server.close();
      error ? reject(error) : resolveCode(value!);
    };
    const giveUp = setTimeout(() => finish(new Error("Gmail sign-in wasn't finished within 5 minutes. Run npm run setup again.")), 5 * 60_000);
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") return void res.writeHead(404).end();
      const value = url.searchParams.get("code");
      res.writeHead(200, { "content-type": "text/plain" }).end(value ? "Gmail connected. You can close this tab." : "Gmail sign-in failed. Go back to the terminal.");
      value ? finish(null, value) : finish(new Error(`Google said: ${url.searchParams.get("error") ?? "no code"}`));
    });
    server.on("error", (error) => finish(new Error(`Couldn't listen for Google's reply on this computer: ${error.message}`)));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      redirectUri = `http://127.0.0.1:${port}/callback`;
      openUrl(client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: [SCOPE], redirect_uri: redirectUri }));
    });
  });
  const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
  client.setCredentials(tokens);
  writeFileSync(tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  return client;
}

type GmailMessage = { id: string; payload?: { headers?: { name: string; value: string }[] }; snippet?: string; internalDate?: string };

/** Adds every confirmation from the last `days` days to the ledger; returns how many were new. */
export async function syncConfirmations(client: OAuth2Client, ledger: Ledger, days: number): Promise<number> {
  const base = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
  const list = await client.request<{ messages?: { id: string }[] }>({ url: base, params: { q: `${QUERY} newer_than:${days}d`, maxResults: 200 } });
  let added = 0;
  for (const { id } of list.data.messages ?? []) {
    const { data } = await client.request<GmailMessage>({ url: `${base}/${id}`, params: { format: "metadata", metadataHeaders: ["Subject", "From"] } });
    const header = (name: string) => data.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
    const parsed = parseConfirmation(header("Subject"), header("From"), data.snippet ?? "");
    if (!parsed) continue;
    const key = `email:${parsed.company.toLowerCase()}:${(parsed.title ?? "").toLowerCase()}:${id}`;
    if (ledger.all().some((entry) => entry.key.endsWith(`:${id}`))) continue;
    ledger.add({ key, company: parsed.company, title: parsed.title ?? "", by: "inbox", outcome: "submitted", reason: `confirmation email: ${header("Subject").slice(0, 120)}` });
    added++;
  }
  return added;
}

export type CodeEmail = { id: string; receivedAt: number; text: string };

/**
 * Which security code to use, from the code emails received so far: only ones
 * that arrived after this job's Submit click, never a code already tried, and
 * the newest one naming this company first (two jobs submitted a minute apart
 * both get code emails; the company name tells them apart).
 */
export function chooseCode(emails: CodeEmail[], options: { since: Date; company?: string; used: Set<string> }): { code: string; id: string } | null {
  const companyWords = (options.company ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !["inc", "llc", "the", "corp", "company", "group", "com"].includes(word));
  const fresh = emails
    .filter((email) => email.receivedAt >= options.since.getTime())
    .map((email) => ({ ...email, code: extractCode(email.text) }))
    .filter((email): email is CodeEmail & { code: string } => Boolean(email.code) && !options.used.has(email.code!))
    .sort((a, b) => b.receivedAt - a.receivedAt);
  const names = (email: CodeEmail) => companyWords.length > 0 && companyWords.every((word) => email.text.toLowerCase().includes(word));
  const pick = fresh.find(names) ?? (companyWords.length ? fresh.filter((email) => !otherCompany(email.text)).at(0) ?? null : fresh[0] ?? null);
  return pick ? { code: pick.code, id: pick.id } : null;
}

/** Whether a code email clearly names some company (so it may belong to another job). */
function otherCompany(text: string): boolean {
  return /application (to|for|at) [A-Z]/.test(text);
}

/**
 * Waits for this job's security code (Greenhouse emails one, 8 characters) and
 * returns it. Every code it returns is remembered in `used`, so a run never
 * types another job's code twice. Checks every 5 seconds for 3 minutes.
 */
export async function waitForSecurityCode(client: OAuth2Client, since: Date, options: { company?: string; used: Set<string> }, timeoutMs = 180_000): Promise<string | null> {
  const base = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
  const deadline = Date.now() + timeoutMs;
  const cache = new Map<string, CodeEmail>();
  while (Date.now() < deadline) {
    const list = await client.request<{ messages?: { id: string }[] }>({ url: base, params: { q: 'newer_than:1h ("security code" OR "verification code")', maxResults: 15 } });
    for (const { id } of list.data.messages ?? []) {
      if (cache.has(id)) continue;
      const { data } = await client.request<GmailMessage & { payload?: { headers?: { name: string; value: string }[]; body?: { data?: string }; parts?: { mimeType: string; body?: { data?: string } }[] } }>({ url: `${base}/${id}`, params: { format: "full" } });
      const subject = data.payload?.headers?.find((h) => h.name.toLowerCase() === "subject")?.value ?? "";
      const bodies = [data.payload?.body?.data, ...(data.payload?.parts ?? []).map((part) => part.body?.data)].filter(Boolean) as string[];
      const text = [subject, data.snippet ?? "", ...bodies.map((body) => Buffer.from(body, "base64url").toString("utf8").replace(/<[^>]+>/g, " "))].join(" ");
      cache.set(id, { id, receivedAt: Number(data.internalDate ?? 0), text });
    }
    const chosen = chooseCode([...cache.values()], { since, company: options.company, used: options.used });
    if (chosen) {
      options.used.add(chosen.code);
      return chosen.code;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return null;
}

/**
 * The code in a security-code email. First the token right after a colon that
 * follows "application" or "code" ("…field on your application: Xk3pQ9aB");
 * else the first 6–8 character token with a digit after a "code" mention.
 * Words such as a company name ("Acme") are never taken for a code.
 */
export function extractCode(text: string): string | null {
  const clean = text.replace(/\s+/g, " ");
  const anchored = clean.match(/(?:application|code)\s*[:：]\s*([A-Za-z0-9]{6,8})\b/i)?.[1];
  if (anchored && !/^(security|password|verify|confirm)/i.test(anchored)) return anchored;
  for (const at of clean.matchAll(/code/gi)) {
    const after = clean.slice(at.index ?? 0, (at.index ?? 0) + 300);
    for (const match of after.matchAll(/\b([A-Za-z0-9]{6,8})\b/g)) if (/\d/.test(match[1])) return match[1];
  }
  return null;
}

/** Company and job title from a confirmation's subject, sender and preview. */
export function parseConfirmation(subject: string, from: string, snippet: string): { company: string; title?: string } | null {
  const text = `${subject} ${snippet}`.replace(/\s+/g, " ");
  const patterns: RegExp[] = [
    /thank(?:s| you) for (?:applying|your application|your interest) (?:to|at|with|in) (?<company>[^!.,|]+?)(?:[!.,|]| - |$)/i,
    /your application (?:to|for|at) (?:the )?(?<title>[^!.,|]+?) (?:position |role )?at (?<company>[^!.,|]+?)(?:[!.,|]| - |$)/i,
    /(?:application|applying) for (?:the )?(?<title>[^!.,|]+?) (?:position |role )?(?:at|with) (?<company>[^!.,|]+?)(?:[!.,|]| - |$)/i,
    /(?<company>[^!.,|:]+?) (?:has )?received your application/i,
    /your application (?:to|at|with) (?<company>[^!.,|]+?)(?:[!.,|]| - |$)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.groups?.company) return { company: match.groups.company.trim(), title: match.groups.title?.trim() };
  }
  // Fall back to the sender's display name, e.g. "Acme Recruiting <no-reply@greenhouse.io>".
  const sender = from.match(/^"?([^"<]+?)"?\s*</)?.[1]?.replace(/\b(recruiting|careers|talent( acquisition)?|hiring team|jobs|hr)\b/gi, "").trim();
  return sender && /appl/i.test(text) ? { company: sender } : null;
}
