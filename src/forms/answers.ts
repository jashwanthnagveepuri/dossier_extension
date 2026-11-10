import type { AnswerBank } from "../config.js";

// Every question the applier is allowed to answer, and its answer from the
// answer bank. A question that matches nothing here is never answered: if it's
// required, the application is left as a draft for you.

export type FieldKind = "text" | "textarea" | "email" | "tel" | "url" | "number" | "date" | "select" | "radio" | "checkbox" | "checkboxes" | "combobox" | "file";

export type Field = {
  id: string; // data-applier-id given to the element on the page
  kind: FieldKind;
  label: string;
  required: boolean;
  options: string[]; // for select, radio, checkboxes (and combobox once opened)
  name?: string;
};

export type Answer =
  | { kind: "text"; value: string }
  | { kind: "choice"; prefer: string[] } // option texts to look for, best first
  | { kind: "file"; which: "resume" | "cover_letter" }
  | { kind: "check" }
  | { kind: "choices"; include: RegExp[]; exclude: RegExp[]; text: string; fallback: string[] } // every option that fits (checkbox lists)
  | { kind: "skip" } // optional and not ours to fill
  | { kind: "needs_you"; why: string };

type Rule = {
  description: string; // what the key means, for the AI matcher
  match: RegExp[];
  answer: (bank: AnswerBank, field: Field) => Answer;
};

const yesNo = (value: "Yes" | "No"): Answer => ({ kind: "choice", prefer: value === "Yes" ? ["yes"] : ["no"] });
/** A yes/no question that may be a text box, a select or radios. */
const yesNoField = (value: "Yes" | "No", field: Field): Answer => (isChoice(field) ? yesNo(value) : { kind: "text", value });
const isChoice = (field: Field) => ["select", "radio", "checkboxes", "combobox"].includes(field.kind);
const textOrChoice = (value: string, prefer: string[], field: Field): Answer => (isChoice(field) ? { kind: "choice", prefer } : { kind: "text", value });
const needsYou = (why: string): Answer => ({ kind: "needs_you", why });

/**
 * Sponsorship depends on when the question asks about: "Do you now require
 * sponsorship?" is No while a temporary authorization (such as OPT) covers today; the future (or "now or in the future", or
 * no time given) is Yes.
 */
export function sponsorshipAnswer(label: string, bank: AnswerBank): "Yes" | "No" {
  const future = /future|later|at any (point|time)|ever\b|to maintain|going forward|will you (ever )?(need|require)|eventually/i.test(label);
  const now = /\bnow\b|currently|at this time|presently|at present|today|to (begin|start) (employment|working)/i.test(label);
  if (now && !future) return bank.work_authorization.requires_sponsorship_now;
  return bank.work_authorization.requires_sponsorship_now_or_future;
}

/** Ordered: the first rule whose pattern matches the label wins, so specific rules come first. */
export const RULES: Record<string, Rule> = {
  // ---- Things only you can answer ----
  criminal_history: { description: "criminal history, convictions, background check disclosures", match: [/criminal|convicted|conviction|felony|misdemeanor|offen[cs]e|arrest/i], answer: () => needsYou("criminal history question") },
  relatives: {
    description: "relatives or friends working at the company",
    match: [/relative|family member|related to (an?|any) (employee|person)|friends?.*(employ|work)|know (anyone|anybody|someone) (who (currently )?works? )?(at|here|for)/i],
    answer: (bank, field) => (bank.personal.relatives_at_company ? (isChoice(field) ? yesNo(bank.personal.relatives_at_company) : { kind: "text", value: bank.personal.relatives_at_company }) : needsYou("relatives at the company")),
  },
  agreements: {
    description: "non-compete, non-solicitation, post-employment restrictions or other agreements with an employer",
    match: [/non-?compete|non-?solicit|restrictive covenant|post-?employment|employment agreements?|bound by .{0,20}agreement|subject to any .{0,30}(agreement|restriction)/i],
    answer: (bank, field) => (bank.personal.bound_by_employment_agreements ? yesNoField(bank.personal.bound_by_employment_agreements, field) : needsYou("employment agreements or non-compete")),
  },
  auth_expiry: { description: "the date the current work authorization or EAD expires", match: [/(when|date|what day).{0,40}(ead|work authori[sz]ation|visa|opt|permit).{0,40}(expir|end|valid until)|(ead|opt|work authori[sz]ation).{0,20}(expiration|end) date|expir(y|ation) date/i], answer: () => needsYou("work authorization end date") },
  // "Is your authorization temporary or subject to expiration?" is a yes/no, not a date.
  temporary_authorization: {
    description: "whether the candidate's work authorization is temporary or subject to expiration (yes/no)",
    match: [/(temporary|subject to expiration|time[- ]limited|expir(e|es|ing|ation)).{0,80}(authori[sz]ation|ead|visa|opt|status|permit)|(authori[sz]ation|ead|visa|status).{0,60}(temporary|subject to expiration)/i],
    answer: (bank, field) => (isChoice(field) || field.kind === "text" ? yesNoField(bank.work_authorization.authorization_is_temporary, field) : { kind: "skip" }),
  },

  // ---- Work authorization (before the generic "authorized" rule) ----
  sponsorship: {
    description: "whether the candidate now or in the future requires visa sponsorship",
    match: [/sponsor/i, /(h-?1b|visa).{0,40}(require|need)/i, /(require|need).{0,40}(h-?1b|visa)/i],
    answer: (bank, field) => {
      const want = sponsorshipAnswer(field.label, bank);
      if (want === "No" || !isChoice(field)) return yesNoField(want, field);
      // "Now" vs "in the future" as options: you need it in the future.
      return { kind: "choice", prefer: bank.work_authorization.sponsorship_needed === "future" ? ["yes, in the future", "in the future", "yes - in the future", "future", "yes"] : ["yes, now", "yes"] };
    },
  },
  visa_status: {
    description: "the candidate's current visa or work authorization type, as text",
    match: [/(current|what is your).{0,30}(visa|immigration|work authori[sz]ation) (status|type)|(visa|immigration) status/i],
    answer: (bank, field) => (isChoice(field) ? needsYou("visa status as a list of options") : { kind: "text", value: bank.work_authorization.current_status_text }),
  },
  authorized: {
    description: "whether the candidate is legally authorized to work in the United States",
    match: [/(legally )?(authori[sz]ed|eligible|permitted|able) to work/i, /work authori[sz]ation/i, /right to work/i],
    answer: (bank, field) => yesNoField(bank.work_authorization.authorized_to_work_in_us, field),
  },
  over_18: { description: "whether the candidate is at least 18 years old", match: [/(18|eighteen) years|age of (18|majority)|over 18|at least 18/i], answer: (bank, field) => yesNoField(bank.work_authorization.over_18, field) },

  // ---- Voluntary self-identification ----
  hispanic: { description: "Hispanic or Latino ethnicity (EEO)", match: [/hispanic|latin[oax]/i], answer: (bank) => ({ kind: "choice", prefer: bank.voluntary_self_identification.hispanic_or_latino === "No" ? ["no", "not hispanic"] : ["yes", "hispanic or latino"] }) },
  race: {
    description: "race or ethnicity (EEO)",
    match: [/\brac(e|ial)\b|ethnic/i],
    // A form that splits one race into subgroups (East / South / Southeast Asian) uses race_detail when you set one.
    answer: (bank) => {
      const self = bank.voluntary_self_identification;
      return { kind: "choice", prefer: [self.race_detail, self.race].filter((v): v is string => Boolean(v)).map((v) => v.toLowerCase()) };
    },
  },
  gender: { description: "gender (EEO)", match: [/\bgender\b|\bsex\b/i], answer: (bank) => ({ kind: "choice", prefer: [bank.voluntary_self_identification.gender.toLowerCase(), bank.voluntary_self_identification.gender === "Male" ? "man" : "woman"] }) },
  veteran: { description: "protected veteran status (EEO)", match: [/veteran/i], answer: (bank) => ({ kind: "choice", prefer: [bank.voluntary_self_identification.veteran_status.toLowerCase(), "not a protected veteran", "i am not a veteran", "no"] }) },
  accommodation: {
    description: "whether the candidate needs adjustments or accommodations for the interview or hiring process",
    match: [/(adjustments?|accommodations?).{0,120}(interview|hiring|process|assist|need|require)|reasonable (support|accommodation)/i],
    answer: (bank, field) => (isChoice(field) ? { kind: "choice", prefer: bank.personal.needs_interview_adjustments === "No" ? ["no", "none", "i do not require", "no adjustments", "not at this time"] : ["yes"] } : { kind: "text", value: bank.personal.needs_interview_adjustments }),
  },
  disability: { description: "disability status (EEO)", match: [/disabilit/i], answer: (bank) => ({ kind: "choice", prefer: [bank.voluntary_self_identification.disability.toLowerCase(), "no, i do not have a disability", "no, i don't have a disability", "no"] }) },
  pronouns: { description: "pronouns", match: [/pronoun/i], answer: (_bank, field) => (field.required ? needsYou("pronouns") : { kind: "skip" }) },

  // ---- Documents ----
  resume: { description: "resume or CV file", match: [/^(?![\s\S]*\b(certify|attest|acknowledge|agree|accurate|true and complete)\b)[\s\S]*(resume|résumé|\bcv\b|curriculum vitae)/i], answer: (_bank, field) => (field.kind === "file" ? { kind: "file", which: "resume" } : { kind: "skip" }) },
  cover_letter: {
    description: "cover letter",
    match: [/cover letter|motivation letter/i],
    answer: (bank, field) => {
      const setting = bank.documents.cover_letter;
      if (!field.required) {
        // Optional upload: attach only when you chose "always". Optional text boxes stay blank.
        return setting === "always" && field.kind === "file" ? { kind: "file", which: "cover_letter" } : { kind: "skip" };
      }
      if (setting === "never") return needsYou("cover letter required");
      return field.kind === "file" ? { kind: "file", which: "cover_letter" } : needsYou("cover letter as a text box");
    },
  },

  // ---- Identity and links ----
  preferred_name: { description: "preferred first name", match: [/preferred (first )?name|nickname|goes by|name (you'?d|you would|do you) prefer|prefer(red)? to be called|what should we call you/i], answer: (bank) => ({ kind: "text", value: bank.identity.preferred_name }) },
  first_name: { description: "legal first name", match: [/first name|given name|forename/i], answer: (bank) => ({ kind: "text", value: bank.identity.legal_first_name }) },
  last_name: { description: "legal last name", match: [/last name|family name|surname/i], answer: (bank) => ({ kind: "text", value: bank.identity.legal_last_name }) },
  full_name: { description: "full name", match: [/^\s*(full |legal )?name\s*\*?\s*$/i], answer: (bank) => ({ kind: "text", value: `${bank.identity.legal_first_name} ${bank.identity.legal_last_name}` }) },
  email: { description: "email address", match: [/e-?mail/i], answer: (bank) => ({ kind: "text", value: bank.identity.email }) },
  phone: { description: "phone number", match: [/phone|mobile|cell/i], answer: (bank, field) => (isChoice(field) ? needsYou("phone type list") : { kind: "text", value: bank.identity.phone }) },
  linkedin: { description: "LinkedIn profile URL", match: [/linked\s*in/i], answer: (bank) => ({ kind: "text", value: bank.identity.linkedin }) },
  github: { description: "GitHub profile URL", match: [/git\s*hub/i], answer: (bank) => ({ kind: "text", value: bank.identity.github }) },
  website: { description: "personal website or portfolio URL", match: [/portfolio|website|personal (site|url)|other (link|url)|\burl\b/i], answer: (bank) => ({ kind: "text", value: bank.identity.portfolio }) },

  // ---- Address and location ----
  street: { description: "street address", match: [/street|address( line)? ?1|^\s*address\s*\*?$/i], answer: (bank) => ({ kind: "text", value: bank.identity.address.street }) },
  address2: { description: "second address line", match: [/address( line)? ?2|apt|suite/i], answer: () => ({ kind: "skip" }) },
  zip: { description: "ZIP or postal code", match: [/zip|postal/i], answer: (bank) => ({ kind: "text", value: bank.identity.address.postal_code }) },
  state: { description: "state or province", match: [/^\s*(state|province)\b|state\s*\/\s*province|state of residence/i], answer: (bank, field) => textOrChoice(bank.identity.address.state, [bank.identity.address.state.toLowerCase(), bank.identity.address.state_code.toLowerCase()], field) },
  country: { description: "country of residence", match: [/country/i], answer: (bank, field) => textOrChoice(bank.identity.address.country, ["united states", "united states of america", "usa", "us"], field) },
  city: { description: "city", match: [/^\s*city\b/i], answer: (bank, field) => textOrChoice(bank.identity.address.city, [bank.identity.address.city.toLowerCase()], field) },
  work_location: {
    description: "the city and state the candidate will work from (for payroll or tax purposes)",
    match: [/payroll|tax purposes|plan (on|to) work(ing)? from|where will you (be )?work(ing)? from|state (you|in which you)( will)? work/i],
    answer: (bank, field) => {
      const { city, state, state_code } = bank.identity.address;
      return textOrChoice(`${city}, ${state}`, [state.toLowerCase(), state_code.toLowerCase(), `${city.toLowerCase()}, ${state.toLowerCase()}`, city.toLowerCase()], field);
    },
  },
  location_preference: {
    description: "which work locations or arrangements the candidate prefers (a list of offices, remote regions, relocation)",
    match: [/location preference|preferred (work )?locations?|where would you (like|prefer) to (work|be based)|which (of (these|the following) )?(locations?|offices?)|work location preference/i],
    answer: (bank) => {
      // US remote, US offices and US relocation fit when you're open to anywhere in the US; other countries don't.
      const anywhere = bank.logistics.willing_to_relocate === "Yes";
      const us = /\b(us|u\.s\.|usa|united states|remote|anywhere|hybrid|on-?site|in[- ]office|nyc|new york|sf|san francisco|seattle|austin|boston|chicago|denver|los angeles|la|atlanta|miami|dallas|houston)\b|relo/i;
      const mine = new RegExp(`\\b(${bank.identity.address.city}|${bank.identity.address.state}|remote)\\b`, "i");
      return {
        kind: "choices",
        include: [anywhere ? us : mine],
        exclude: [/canada|international|outside (the )?(us|united states)|non-us|europe|emea|apac|latam|uk\b|india|mexico|brazil/i],
        text: anywhere ? "Anywhere in the United States (remote, hybrid or on-site)" : `${bank.identity.address.city}, ${bank.identity.address.state} or remote`,
        fallback: ["remote - us", "remote (us)", "united states", "remote", "anywhere"],
      };
    },
  },
  location: {
    description: "where the candidate currently lives (city and state)",
    match: [/(current )?location|where are you (based|located)|city.{0,10}state|reside/i],
    answer: (bank, field) => textOrChoice(`${bank.identity.address.city}, ${bank.identity.address.state}`, [`${bank.identity.address.city.toLowerCase()}, ${bank.identity.address.state.toLowerCase()}`, bank.identity.address.city.toLowerCase()], field),
  },

  // ---- Work logistics ----
  relocate: { description: "willingness to relocate", match: [/relocat/i], answer: (bank, field) => yesNoField(bank.logistics.willing_to_relocate, field) },
  collector: {
    description: "whether the candidate is a collector (trading cards, memorabilia)",
    match: [/are you a collector|do you collect\b|are you a (card|sports card|memorabilia) collector/i],
    answer: (bank, field) => (bank.personal.collector ? yesNoField(bank.personal.collector, field) : field.required ? needsYou("are you a collector") : { kind: "skip" }),
  },
  ai_tools_used: {
    description: "which AI APIs, models or tools the candidate has used to build or integrate an AI solution",
    match: [/which (of the following )?.{0,40}(used|use) to (build|integrate).{0,40}\bai\b|ai (tools?|apis?|models?|platforms?) (have you|do you) (used|use)/i],
    answer: (bank, field) => (isChoice(field) ? { kind: "choice", prefer: [bank.experience.ai_tools_used.toLowerCase(), "anthropic", "claude", "other"] } : { kind: "text", value: bank.experience.ai_tools_used }),
  },
  ai_automation: {
    description: "whether the candidate has built an automation or workflow where AI processes an input and produces an output or triggers an action",
    match: [/built an? (automation|workflow).{0,80}\bai\b|\bai\b.{0,40}takes an input/i],
    answer: (bank, field) => (isChoice(field) || field.kind === "text" ? (isChoice(field) ? yesNo(bank.experience.built_ai_automation) : field.required ? needsYou("explain your AI automation") : { kind: "skip" }) : field.required ? needsYou("explain your AI automation") : { kind: "skip" }),
  },
  onsite: { description: "ability or willingness to work on-site, hybrid or in the office", match: [/on-?site|in[- ]office|in person|hybrid|commut|office.{0,30}days/i], answer: (bank, field) => yesNoField(bank.logistics.onsite_or_hybrid_ok, field) },
  start_date: { description: "earliest start date or notice period", match: [/start date|when can you start|available to start|notice period|availability/i], answer: (bank, field) => (isChoice(field) ? { kind: "choice", prefer: ["2 weeks", "two weeks", "within 2 weeks", "less than 1 month", "1 month"] } : { kind: "text", value: bank.logistics.start_date_text }) },
  salary: {
    description: "desired or expected salary or compensation",
    match: [/salary|compensation|pay (expectation|range)|desired pay|expected (pay|ctc)/i],
    answer: (bank, field) => (field.kind === "number" ? { kind: "text", value: String(bank.compensation.desired_salary_single_number) } : isChoice(field) ? needsYou("salary as a list of options") : { kind: "text", value: bank.compensation.desired_salary_range }),
  },
  how_heard: { description: "how the candidate heard about the job", match: [/how did you (hear|find|learn)|where did you (hear|find|see)|^\s*source\b|referr?al source/i], answer: (bank, field) => textOrChoice(bank.logistics.how_did_you_hear, [bank.logistics.how_did_you_hear.toLowerCase(), "company website", "company careers", "careers page", "website", "other"], field) },
  referral: { description: "whether someone referred the candidate, or the referrer's name", match: [/referr(ed|al)|who referred/i], answer: (_bank, field) => (isChoice(field) ? yesNo("No") : field.required ? needsYou("referral name") : { kind: "skip" }) },
  previously_employed: { description: "whether the candidate worked for this company before", match: [/(previously|ever|have you).{0,30}(work|employ).{0,30}(for|at|by|with)/i], answer: (bank, field) => yesNoField(bank.background.previously_employed_by_this_company, field) },

  // ---- Background ----
  current_company: { description: "current employer or company", match: [/current (company|employer)|(company|employer) name|most recent (company|employer)/i], answer: (bank) => ({ kind: "text", value: bank.background.current_company }) },
  current_title: { description: "current job title", match: [/current (job )?(title|role|position)|most recent (title|role)/i], answer: (bank) => ({ kind: "text", value: bank.background.current_title }) },
  years_experience: {
    description: "total years of professional software experience",
    match: [/years of (professional |relevant |work |industry )?experience|how many years/i],
    answer: (bank, field) => {
      // "Years with Kubernetes" isn't "years of experience": only answer the total.
      if (/years.{0,40}\b(with|in|using)\s+[a-z]/i.test(field.label) || /years of (?!professional|relevant|work|industry|software|total|engineering|development|experience)[a-z]+\s+experience/i.test(field.label)) {
        return field.required ? needsYou(`years with a specific skill: "${field.label.slice(0, 80)}"`) : { kind: "skip" };
      }
      return isChoice(field) ? { kind: "choice", prefer: [`${bank.background.years_of_experience}`, "5+", "5-7", "4-6", "3-5"] } : { kind: "text", value: String(bank.background.years_of_experience) };
    },
  },
  degree: { description: "highest degree earned", match: [/degree|education level|highest level of education/i], answer: (bank, field) => textOrChoice(bank.background.highest_degree, ["master's degree", "master's", "masters", "master"], field) },
  school: { description: "school or university name", match: [/school|university|college|institution/i], answer: (bank, field) => textOrChoice(bank.background.school, [bank.background.school.toLowerCase()], field) },
  discipline: { description: "field of study or major", match: [/discipline|major|field of study/i], answer: (bank, field) => textOrChoice(bank.background.field_of_study, [bank.background.field_of_study.toLowerCase(), "information technology", "computer science"], field) },
  gpa: {
    description: "grade point average (GPA), undergraduate or graduate",
    match: [/\bgpa\b|grade point/i],
    answer: (bank, field) => {
      const graduate = /graduate|master|ms\b|mba/i.test(field.label) && !/undergrad/i.test(field.label);
      const undergrad = /undergrad|bachelor/i.test(field.label);
      if (/doctor|phd/i.test(field.label)) return isChoice(field) ? { kind: "choice", prefer: ["not applicable", "n/a", "did not attend", "none"] } : field.required ? { kind: "text", value: "N/A" } : { kind: "skip" };
      const gpa = undergrad ? bank.education.undergraduate_gpa : graduate ? bank.education.graduate_gpa : bank.education.graduate_gpa;
      return isChoice(field) ? { kind: "choice", prefer: [gpa, `${gpa} out of 4.0`, `${gpa}/4.0`] } : { kind: "text", value: gpa };
    },
  },
  standardized_tests: {
    description: "SAT, ACT, GRE or GMAT scores",
    match: [/\b(SAT|ACT|GRE|GMAT)\b/, /\b(sat|act|gre|gmat)\s+(score|result)/i],
    answer: (bank, field) => {
      const test = (field.label.match(/\b(sat|act|gre|gmat)\b/i)?.[1] ?? "").toLowerCase();
      const score = bank.education.test_scores[test as keyof typeof bank.education.test_scores];
      if (score === undefined || score === "ask") return field.required ? needsYou(`${test.toUpperCase()} score`) : { kind: "skip" };
      if (score === "none") return isChoice(field) ? { kind: "choice", prefer: ["did not take", "not applicable", "n/a", "none"] } : field.required ? { kind: "text", value: "N/A" } : { kind: "skip" };
      return isChoice(field) ? { kind: "choice", prefer: [String(score)] } : { kind: "text", value: String(score) };
    },
  },
  graduation: { description: "graduation year or date", match: [/graduation (year|date)|year of graduation|when did you graduate|grad(uation)? year/i], answer: (bank) => ({ kind: "text", value: String(bank.background.graduation_year) }) },

  // ---- Consent boxes ----
  acknowledgement: {
    description: "a checkbox to confirm the application is true and complete, or to accept the privacy policy or data processing",
    match: [/(certify|attest|acknowledge|agree|consent|confirm|accept|reviewed|double-check).{0,160}(true|accurate|complete|privacy|policy|notice|terms|data|processing|gdpr)/i],
    answer: (_bank, field) => (field.kind === "checkbox" || field.kind === "checkboxes" ? { kind: "check" } : isChoice(field) ? { kind: "choice", prefer: ["yes", "i agree", "i acknowledge", "i accept", "i confirm", "acknowledge", "confirm", "agree", "accept", "i have read", "i have reviewed", "i understand"] } : { kind: "skip" }),
  },
  // A bare consent box ("Yes, I consent.", "I agree", "I acknowledge"): ticked, never a blocker.
  // Certifications ("I certify the information is accurate") are confirmed; signatures stay with you (see ONLY_YOU_LABEL).
  consent: {
    description: "a box or option to consent, agree or acknowledge (not a certification or signature)",
    match: [/^\s*(yes,?\s*)?(i\s+)?(consent|agree|accept|acknowledge|understand)\b[^?]{0,200}$/i, /\bi (hereby )?(consent|agree|acknowledge|accept)\b/i],
    answer: (_bank, field) => {
      if (/signature|\bsign\b|initials|criminal|convict/i.test(field.label)) return field.required ? needsYou("signature") : { kind: "skip" };
      if (field.kind === "checkbox" || field.kind === "checkboxes") return { kind: "check" };
      if (isChoice(field)) return { kind: "choice", prefer: ["yes, i consent", "i consent", "yes", "i agree", "agree", "i acknowledge", "acknowledge", "i accept", "accept"] };
      return { kind: "skip" };
    },
  },
  sms_consent: {
    description: "opting in or out of text messages about the application",
    match: [/text messages?|\bsms\b|opt[- ]?in.{0,40}(text|message)/i],
    answer: (bank, field) => (isChoice(field) ? { kind: "choice", prefer: bank.personal.text_message_opt_in === "No" ? ["no", "opt out", "i do not", "decline"] : ["yes", "opt in", "i agree"] } : field.kind === "checkbox" && bank.personal.text_message_opt_in === "Yes" ? { kind: "check" } : { kind: "skip" }),
  },
};

/** The rule a label matches, by key, or null. */
export function matchRule(label: string): string | null {
  const clean = label.replace(/\s+/g, " ").trim();
  for (const [key, rule] of Object.entries(RULES)) if (rule.match.some((re) => re.test(clean))) return key;
  return null;
}

/** What to put in a field: from a rule if one matches, else skip (optional) or needs you (required). */
export function answerFor(field: Field, bank: AnswerBank, key: string | null): Answer {
  if (key) return RULES[key].answer(bank, field);
  return field.required ? needsYou(`question not in the answer bank: "${field.label.slice(0, 120)}"`) : { kind: "skip" };
}

/** The only questions that stop an application: you answer these yourself. */
const ONLY_YOU = new Set(["criminal_history", "agreements", "auth_expiry", "pronouns"]);
const ONLY_YOU_LABEL =
  /criminal|convict|felony|misdemeanor|non-?compete|non-?solicit|restrictive covenant|\bsign(ature)?\b|\binitials\b|(ead|work authori[sz]ation|visa|opt|permit).{0,40}expir|expir.{0,30}(ead|authori[sz]ation|visa|opt)|pronoun/i;

/**
 * Whether the AI may answer a question: everything except criminal history,
 * relatives, agreements, EAD dates, pronouns, and signatures or attestations
 * (and never files or single checkboxes, which the answer bank handles).
 */
export function aiMayAnswer(key: string | null, field: Field): boolean {
  if (field.kind === "file" || field.kind === "checkbox") return false;
  if (key && ONLY_YOU.has(key)) return false;
  return !ONLY_YOU_LABEL.test(field.label);
}

/** The descriptions the AI matcher chooses from. Things only you can answer are left out, so it can't pick them. */
export function matcherKeys(): Record<string, string> {
  const hidden = new Set(["criminal_history", "relatives", "agreements", "auth_expiry"]);
  return Object.fromEntries(Object.entries(RULES).filter(([key]) => !hidden.has(key)).map(([key, rule]) => [key, rule.description]));
}

// ---- Choosing an option ----

const normalize = (text: string) => text.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9'+,.-]+/g, " ").trim();

/** The option that best fits the preferences, or null. Whole-word matching, so "male" never picks "Female". */
/**
 * Several options fit ("Yes, H-1B visa", "Yes, Netherlands Highly Skilled Migrant Visa"):
 * take the one about the United States; if that doesn't settle it, pick nothing
 * rather than guess (the AI or you decide).
 */
function oneOf(matches: { option: string; text: string }[]): string | null {
  if (matches.length === 1) return matches[0].option;
  const us = matches.filter(({ text }) => /united states|\bu\.?s\.?a?\b|america|h-?1b|\bopt\b|\bstem\b/.test(text));
  if (us.length === 1) return us[0].option;
  const general = matches.filter(({ text }) => !/netherlands|canada|uk|united kingdom|germany|ireland|india|australia|europe|eu\b|singapore|japan|mexico|brazil/.test(text));
  return general.length === 1 ? general[0].option : null;
}

export function pickOption(options: string[], prefer: string[]): string | null {
  const cleaned = options.map((option) => ({ option, text: normalize(option) })).filter(({ text }) => text && !/^(select|choose|please select|--)/.test(text));
  for (const want of prefer.map(normalize)) {
    const exact = cleaned.find(({ text }) => text === want);
    if (exact) return exact.option;
    const starts = cleaned.filter(({ text }) => text.startsWith(`${want} `) || text.startsWith(`${want},`) || text.startsWith(`${want}.`));
    if (starts.length) return oneOf(starts);
    const word = new RegExp(`(^|[^a-z])${want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`);
    const contains = cleaned.filter(({ text }) => word.test(text) && !(want === "no" && /\bnot? (wish|want)|prefer not|decline/.test(text)));
    if (contains.length) return oneOf(contains);
  }
  return null;
}
