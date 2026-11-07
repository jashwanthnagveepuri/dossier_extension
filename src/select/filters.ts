import type { AnswerBank } from "../config.js";

// The rules that decide whether a posting is worth an application at all,
// before anything is spent on scoring or drafting. All pure functions.

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15 };

/**
 * The fewest years of experience a posting asks for, or null when it doesn't say.
 * "3+ years", "3-5 years", "minimum of 5 years", "five (5) years" all count; years
 * of a degree ("4-year degree") and of company history don't. When a posting
 * names several (e.g. 3 years of Java, 5 years overall), the largest minimum
 * wins, since that's the bar a screener holds the candidate to.
 */
export function requiredYears(text: string): number | null {
  const lower = text.toLowerCase().replace(/[‒-―]/g, "-");
  const found: number[] = [];
  const number = String.raw`(\d{1,2}|${Object.keys(WORDS).join("|")})(?:\s*\(\d{1,2}\))?`;
  const pattern = new RegExp(
    String.raw`(?:at least|minimum(?: of)?|min\.?|over)?\s*${number}\s*(?:\+|plus)?\s*(?:-|to|–)?\s*(?:${number}\s*\+?)?\s*(?:years?|yrs?)\b(?![- ]?(?:degree|old|program))(?=([^.;\n]{0,60}))`,
    "g",
  );
  for (const match of lower.matchAll(pattern)) {
    const tail = match[3] ?? "";
    const before = lower.slice(Math.max(0, (match.index ?? 0) - 40), match.index ?? 0);
    const aboutExperience = /experience|exp\b|professional|industry|working|engineering|development|software|hands-on/.test(tail + before);
    const aboutOther = /company|founded|history|in business|warranty|old\b/.test(tail + before);
    if (!aboutExperience || aboutOther) continue;
    const value = toNumber(match[1]);
    if (value !== null && value > 0 && value <= 25) found.push(value);
  }
  return found.length ? Math.max(...found) : null;
}

function toNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  return WORDS[raw] ?? null;
}

const TITLE_TOO_SENIOR = /\b(staff|principal|distinguished|director|manager|head of|vp|vice president|architect\s+(?:ii|iii|iv))\b/i;
const TITLE_TOO_JUNIOR = /\b(intern|internship|co-?op|apprentice)\b/i;
const NOT_FULL_TIME = /\b(contract(?:or)?|c2c|corp[- ]to[- ]corp|1099|temporary|temp\b|part[- ]time|freelance)\b/i;

const NO_SPONSORSHIP = [
  /(?:not|unable to|cannot|can't|won't|will not|do not|does not|no)\s+(?:be\s+able\s+to\s+)?(?:provide\s+|offer\s+)?(?:visa\s+|immigration\s+|employment\s+)?sponsor/i,
  /sponsorship\s+(?:is\s+)?(?:not|unavailable)/i,
  /without\s+(?:the\s+need\s+for\s+)?(?:current\s+or\s+future\s+)?(?:visa\s+)?sponsorship/i,
  /no\s+(?:visa\s+)?sponsorship/i,
];
/** Export-controlled roles (ITAR/EAR) need U.S. person status, which visa holders usually lack. */
const US_PERSON = [/\bitar\b/i, /export control/i, /u\.?s\.?\s+person/i, /\bear\b.{0,40}(export|regulations)/i, /lawful permanent resident.{0,80}(required|only|must)/i];
/** Titles outside backend, full-stack, platform and general software engineering. */
const OFF_TARGET = /\b(account executive|sales|solutions? (engineer|architect)|sales engineer|security engineer|security analyst|penetration|data scientist|data analyst|machine learning|designer|product manager|program manager|recruiter|support engineer|customer|qa\b|quality assurance|test engineer|sdet|in test|mobile|ios|android|embedded|firmware|hardware|electrical|mechanical|network engineer|site reliability|\bsre\b|technician|marketing)\b/i;
const ON_TARGET = /\b(software|backend|back-end|back end|full[- ]?stack|platform|cloud|java|application|developer|sde|swe|engineer)\b/i;
const NEW_GRAD = /new grad|university grad|recent grad|graduate 20\d\d|class of 20\d\d|early career program|entry[- ]level/i;

const CITIZENSHIP = [/u\.?s\.?\s+citizen(?:ship)?\s+(?:is\s+)?required/i, /must\s+be\s+a\s+u\.?s\.?\s+citizen/i, /green\s+card\s+(?:holders?\s+)?(?:only|required)/i, /(?:only\s+)?u\.?s\.?\s+citizens?\s+(?:or\s+green\s+card\s+holders\s+)?only/i];
const CLEARANCE = [/(?:security|secret|ts\/sci|top secret|public trust)\s+clearance/i, /clearance\s+(?:is\s+)?required/i, /\bts\/sci\b/i];

export type SkipReason = string;

/** Why a posting should be skipped before scoring, or null to keep it. */
export function hardSkip(posting: { title: string; company: string; text: string }, bank: AnswerBank): SkipReason | null {
  const { title, company, text } = posting;
  const blocked = [...bank.do_not_apply.past_employers, ...bank.do_not_apply.other_companies, ...bank.do_not_apply.defense, ...bank.do_not_apply.aggregators].find((name) => sameCompany(company, name));
  if (blocked) return `do-not-apply list (${blocked})`;
  const excluded = bank.targeting.excluded_title_keywords.find((word) => new RegExp(`\\b${escape(word)}\\b`, "i").test(title));
  if (excluded) return `excluded title keyword (${excluded})`;
  if (TITLE_TOO_JUNIOR.test(title)) return "internship or co-op";
  if (NEW_GRAD.test(title)) return "new-grad or entry-level program";
  if (OFF_TARGET.test(title) || !ON_TARGET.test(title)) return "not a backend, full-stack, platform or software engineering role";
  if (NOT_FULL_TIME.test(title)) return "not full-time";
  if (NO_SPONSORSHIP.some((re) => re.test(text))) return "posting says no visa sponsorship";
  if (CITIZENSHIP.some((re) => re.test(text))) return "US citizenship or green card required";
  if (US_PERSON.some((re) => re.test(text))) return "export-controlled role (U.S. person / ITAR required)";
  if (CLEARANCE.some((re) => re.test(text))) return "security clearance required";

  const { from, to } = bank.targeting.experience_years.apply_when_required_min_years;
  const years = requiredYears(text);
  if (years !== null && (years < from || years > to)) return `asks for ${years}+ years (range is ${from}–${to})`;
  if (years === null && TITLE_TOO_SENIOR.test(title)) return "no years stated and the title is above the target level";
  return null;
}

/** "Acme Bank & Co." and "Acme Bank" are the same company. */
export function sameCompany(a: string, b: string): boolean {
  const x = normalizeCompany(a);
  const y = normalizeCompany(b);
  if (!x || !y) return false;
  // Whole words only: "SAIC" must not match "Mosaic".
  const padded = (value: string) => ` ${value} `;
  return padded(x).includes(padded(y)) || padded(y).includes(padded(x));
}

export function normalizeCompany(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|plc|group|holdings|the|pvt|private|solutions)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- Choosing today's applications ----

export type Scored = { key: string; score: number };

/**
 * Today's picks, best first, under the daily cap:
 * every tier with take "all" in order (70+, then 60–69), then the top-up tier
 * (50–59, at most take_max) only when fewer than only_if_fewer_than postings
 * scored at or above the tier above it. Nothing below never_below.
 */
export function pickToday<T extends Scored>(scored: T[], selection: AnswerBank["selection"], alreadyToday = 0): T[] {
  const room = Math.max(0, selection.daily_cap - alreadyToday);
  const sorted = [...scored].filter((item) => item.score >= selection.never_below).sort((a, b) => b.score - a.score);
  const tiers = [...selection.tiers].sort((a, b) => b.min_score - a.min_score);
  const picked: T[] = [];
  let ceiling = Infinity;
  for (const tier of tiers) {
    const band = sorted.filter((item) => item.score >= tier.min_score && item.score < ceiling);
    if (tier.only_if_fewer_than !== undefined) {
      const above = sorted.filter((item) => item.score >= ceiling).length;
      if (above >= tier.only_if_fewer_than) {
        ceiling = tier.min_score;
        continue;
      }
    }
    picked.push(...(tier.take_max !== undefined ? band.slice(0, tier.take_max) : band));
    ceiling = tier.min_score;
  }
  return picked.slice(0, room);
}
