import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { z } from "zod";

/** The project folder (one level above src/). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DATA = join(ROOT, "data");

const text = z.string().trim().min(1);
const yesNo = z.enum(["Yes", "No"]);

export const answerBankSchema = z.object({
  identity: z.object({
    legal_first_name: text,
    legal_last_name: text,
    preferred_name: text,
    email: z.string().email(),
    phone: text,
    address: z.object({ street: text, city: text, state: text, state_code: text, postal_code: text, country: text }),
    linkedin: z.string().url(),
    github: z.string().url(),
    portfolio: z.string().url(),
    other_website: z.string().url().optional(),
  }),
  work_authorization: z.object({
    authorized_to_work_in_us: yesNo,
    requires_sponsorship_now_or_future: yesNo,
    current_status_text: text,
    authorization_expiry_date: z.string(),
    authorization_is_temporary: yesNo,
    sponsorship_needed: z.enum(["now", "future"]).default("future"),
    requires_sponsorship_now: yesNo.default("No"),
    over_18: yesNo,
  }),
  background: z.object({
    current_company: text,
    current_title: text,
    years_of_experience: z.number().int(),
    highest_degree: text,
    school: text,
    degree_name: text,
    field_of_study: text,
    graduation_year: z.number().int(),
    previously_employed_by_this_company: yesNo,
  }),
  education: z.object({
    graduate_gpa: text,
    undergraduate_gpa: text,
    test_scores: z.object({ sat: z.union([z.literal("none"), z.literal("ask"), z.number()]), act: z.union([z.literal("none"), z.literal("ask"), z.number()]), gre: z.union([z.literal("none"), z.literal("ask"), z.number()]), gmat: z.union([z.literal("none"), z.literal("ask"), z.number()]) }),
  }),
  experience: z
    .object({ ai_tools_used: text, built_ai_automation: yesNo })
    .default({ ai_tools_used: "Claude API", built_ai_automation: "Yes" }),
  personal: z.object({
    bound_by_employment_agreements: yesNo.optional(),
    relatives_at_company: yesNo.optional(),
    needs_interview_adjustments: z.string().default("No"),
    collector: yesNo.optional(),
    text_message_opt_in: yesNo,
  }),
  compensation: z.object({ desired_salary_range: text, desired_salary_single_number: z.number().int(), currency: text }),
  logistics: z.object({
    willing_to_relocate: yesNo,
    onsite_or_hybrid_ok: yesNo,
    start_date_text: text,
    notice_period_weeks: z.number().int(),
    how_did_you_hear: text,
  }),
  voluntary_self_identification: z.object({
    gender: text,
    hispanic_or_latino: yesNo,
    race: text,
    race_detail: z.string().trim().optional(), // a subgroup for forms that split a race into several options
    veteran_status: text,
    disability: text,
  }),
  documents: z.object({ resume: text, cover_letter: z.enum(["only_when_required", "always", "never"]) }),
  ai_answers: z.object({ enabled: z.boolean(), max_words: z.number().int().min(20).max(300) }).default({ enabled: true, max_words: 120 }),
  targeting: z.object({
    employment_types: z.array(text),
    excluded_title_keywords: z.array(text),
    experience_years: z.object({
      apply_when_required_min_years: z.object({ from: z.number(), to: z.number() }),
    }),
    skip_if_posting_says: z.array(text),
  }),
  selection: z.object({
    daily_cap: z.number().int().min(1).max(100),
    tiers: z.array(
      z.object({
        min_score: z.number(),
        take: z.literal("all").optional(),
        take_max: z.number().int().optional(),
        only_if_fewer_than: z.number().int().optional(),
      }),
    ),
    never_below: z.number(),
  }),
  do_not_apply: z.object({
    past_employers: z.array(text).default([]),
    other_companies: z.array(text).default([]),
    aggregators: z.array(text).default([]),
    defense: z.array(text).default([]), // older name for other_companies; still read
  }),
});
export type AnswerBank = z.infer<typeof answerBankSchema>;

export const settingsSchema = z.object({
  dossier: z.object({ url: z.string().url(), password_env: text }),
  anthropic: z.object({ api_key_env: text, model: text }),
  search: z.object({
    country: text,
    posted_within: z.enum(["any", "day", "3days", "week", "month"]),
    queries: z.array(text).min(1),
  }),
  browser: z.object({ headless: z.boolean(), slow_mo_ms: z.number().int().min(0) }),
  phase: z.object({ sites: z.array(z.enum(["greenhouse", "lever", "ashby", "workday", "other"])) }),
  gmail: z.object({ enabled: z.boolean(), client_file: text, lookback_days: z.number().int().min(1) }),
});
export type Settings = z.infer<typeof settingsSchema>;

function loadYaml<S extends z.ZodTypeAny>(file: string, schema: S): z.infer<S> {
  const path = join(ROOT, file);
  const parsed = schema.safeParse(parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${file}: ${issue.path.join(".")}: ${issue.message}`);
  }
  return parsed.data;
}

/** Tests always use the made-up example, so they pass the same on every machine. */
const testing = () => process.env.VITEST !== undefined || process.env.APPLIER_EXAMPLE_BANK === "1";

/** Your answers (config/answer-bank.yaml, git-ignored); the made-up example in tests or before you've made yours. */
export function loadAnswerBank(): AnswerBank {
  const mine = "config/answer-bank.yaml";
  if (!testing() && existsSync(join(ROOT, mine))) return loadYaml(mine, answerBankSchema);
  if (!testing()) console.warn("Using config/answer-bank.example.yaml (a made-up person). Copy it to config/answer-bank.yaml and fill in your own answers.");
  return loadYaml("config/answer-bank.example.yaml", answerBankSchema);
}

/** "First_Last_Resume.pdf": the file name employers see. */
export function documentName(bank: AnswerBank, kind: "Resume" | "Cover_Letter"): string {
  const name = `${bank.identity.legal_first_name} ${bank.identity.legal_last_name}`.trim().replace(/[^A-Za-z0-9]+/g, "_");
  return `${name}_${kind}.pdf`;
}

export function loadSettings(): Settings {
  return loadYaml("config/settings.yaml", settingsSchema);
}

/** Reads .env once, if there is one; real environment variables win. */
export function loadEnv(): void {
  const path = join(ROOT, ".env");
  if (existsSync(path)) process.loadEnvFile(path);
}

export function secret(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} isn't set. Add it to .env (see .env.example).`);
  return value;
}

/** A folder under data/, created when missing. */
export function dataDir(...parts: string[]): string {
  const dir = join(DATA, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}
