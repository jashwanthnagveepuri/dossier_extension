import { describe, expect, it } from "vitest";

import { loadAnswerBank } from "../src/config.js";
import { answerFor, matchRule, pickOption, type Field } from "../src/forms/answers.js";
import { parseConfirmation } from "../src/gmail.js";
import { identify, sameJob } from "../src/select/canonical.js";
import { hardSkip, pickToday, requiredYears, sameCompany } from "../src/select/filters.js";

const bank = loadAnswerBank();
const field = (label: string, kind: Field["kind"] = "text", options: string[] = [], required = true): Field => ({ id: "x", label, kind, options, required });

describe("required years", () => {
  it.each([
    ["3+ years of professional software engineering experience", 3],
    ["Minimum of 5 years of experience building backend services", 5],
    ["2-4 years of experience in Java", 2],
    ["five (5) years of industry experience", 5],
    ["7+ years of hands-on software development", 7],
    ["We were founded 20 years ago", null],
    ["Bachelor's degree or 4-year degree in CS", null],
    ["3+ years with Java and 5+ years of software engineering experience", 5],
  ])("%s → %s", (text, expected) => expect(requiredYears(text)).toBe(expected));
});

describe("hard skips", () => {
  const posting = (text: string, title = "Software Engineer", company = "Acme") => hardSkip({ title, company, text }, bank);
  it("keeps a 3+ years Java role", () => expect(posting("3+ years of experience with Java and Spring Boot")).toBeNull());
  it("skips 6+ years", () => expect(posting("6+ years of software engineering experience")).toMatch(/6\+ years/));
  it("skips 1 year", () => expect(posting("1+ years of experience")).toMatch(/1\+ years/));
  it("skips no sponsorship", () => expect(posting("We are unable to sponsor visas for this role. 3+ years experience")).toMatch(/sponsorship/));
  it("skips 'without sponsorship'", () => expect(posting("Must be authorized to work in the US without the need for current or future visa sponsorship.")).toMatch(/sponsorship/));
  it("skips clearance", () => expect(posting("Active Secret clearance required. 3 years of experience")).toMatch(/clearance/));
  it("skips citizenship", () => expect(posting("Must be a U.S. citizen. 3 years of experience")).toMatch(/citizenship/));
  it("skips do-not-apply companies", () => expect(posting("3 years of experience", "Software Engineer", "Example Bank & Co.")).toMatch(/do-not-apply/));
  it("doesn't confuse SAIC with Mosaic", () => expect(posting("3 years of experience", "Software Engineer", "Mosaic")).toBeNull());
  it("skips AI titles", () => expect(posting("3 years of experience", "Machine Learning Engineer")).toMatch(/excluded/));
  it("skips staff titles when years aren't stated", () => expect(posting("Build great things", "Staff Software Engineer")).toMatch(/above the target/));
  it("skips contracts", () => expect(posting("3 years of experience", "Java Developer (Contract)")).toMatch(/full-time/));
  it("matches company names", () => {
    expect(sameCompany("Globex Solutions Pvt. Ltd.", "Globex")).toBe(true);
    expect(sameCompany("Booz Allen Hamilton Inc.", "Booz Allen Hamilton")).toBe(true);
    expect(sameCompany("Stripe", "Globex")).toBe(false);
  });
});

describe("today's picks", () => {
  const items = (...scores: number[]) => scores.map((score, i) => ({ key: `k${i}`, score }));
  it("takes 70+ then 60s, best first, up to the cap", () => {
    const picks = pickToday(items(91, 72, 65, 61, 55, 40), bank.selection);
    expect(picks.map((p) => p.score)).toEqual([91, 72, 65, 61, 55]);
  });
  it("tops up with at most 5 from 50–59 only on thin days", () => {
    const thin = pickToday(items(80, 75, 62, 59, 58, 57, 56, 55, 54, 51), bank.selection);
    expect(thin.map((p) => p.score)).toEqual([80, 75, 62, 59, 58, 57, 56, 55]);
    const busy = pickToday(items(...Array(10).fill(65), 59, 58), bank.selection);
    expect(busy.every((p) => p.score >= 60)).toBe(true);
  });
  it("respects the daily cap and what's already sent today", () => {
    expect(pickToday(items(...Array(30).fill(80)), bank.selection)).toHaveLength(15);
    expect(pickToday(items(...Array(30).fill(80)), bank.selection, 12)).toHaveLength(3);
  });
  it("never goes below 50", () => expect(pickToday(items(49, 30), bank.selection)).toHaveLength(0));
});

describe("job identity", () => {
  it("reads Greenhouse links", () => {
    expect(identify("https://boards.greenhouse.io/acme/jobs/123456?gh_src=x")?.key).toBe("greenhouse:acme:123456");
    expect(identify("https://job-boards.greenhouse.io/acme/jobs/123456")?.key).toBe("greenhouse:acme:123456");
    expect(identify("https://acme.com/careers?gh_jid=123456")?.site).toBe("greenhouse");
    expect(sameJob("greenhouse:?:123456", "greenhouse:acme:123456")).toBe(true);
  });
  it("reads Lever links and points at the form", () => {
    const job = identify("https://jobs.lever.co/acme/0a1b2c3d-1111-2222-3333-444455556666");
    expect(job?.key).toBe("lever:acme:0a1b2c3d-1111-2222-3333-444455556666");
    expect(job?.applyUrl).toMatch(/\/apply$/);
  });
  it("reads Workday requisition ids", () => {
    expect(identify("https://acme.wd5.myworkdayjobs.com/en-US/External/job/Springfield-IL/Software-Engineer_R-12345")?.key).toBe("workday:acme:r-12345");
  });
});

describe("question matching", () => {
  it.each([
    ["Will you now or in the future require sponsorship for employment visa status?", "sponsorship"],
    ["Are you legally authorized to work in the United States?", "authorized"],
    ["LinkedIn Profile", "linkedin"],
    ["Preferred First Name", "preferred_name"],
    ["First Name", "first_name"],
    ["Have you ever been convicted of a felony?", "criminal_history"],
    ["When does your EAD expire?", "auth_expiry"],
    ["Are you Hispanic/Latino?", "hispanic"],
    ["Veteran Status", "veteran"],
    ["Disability Status", "disability"],
    ["What are your salary expectations?", "salary"],
    ["How did you hear about this job?", "how_heard"],
    ["Are you willing to relocate?", "relocate"],
    ["This role is hybrid, 3 days a week in office. Are you able to commit?", "onsite"],
    ["Resume/CV", "resume"],
    ["I certify that the information in this application is true and complete", "acknowledgement"],
    ["Do you have experience with open source projects?", null],
  ])("%s → %s", (label, key) => expect(matchRule(label)).toBe(key));

  it("answers sponsorship Yes and authorization Yes", () => {
    expect(pickOption(["Yes", "No"], (answerFor(field("Will you require sponsorship?", "select", ["Yes", "No"]), bank, "sponsorship") as { prefer: string[] }).prefer)).toBe("Yes");
    expect(answerFor(field("Authorized to work?", "radio", ["Yes", "No"]), bank, "authorized")).toEqual({ kind: "choice", prefer: ["yes"] });
  });
  it("never answers years with a specific skill", () => {
    expect(answerFor(field("How many years of experience do you have with Kubernetes?"), bank, "years_experience").kind).toBe("needs_you");
    expect(answerFor(field("Years of professional experience"), bank, "years_experience")).toEqual({ kind: "text", value: "5" });
  });
  it("leaves required unknown questions to you, optional ones blank", () => {
    expect(answerFor(field("Why do you want to work here?", "textarea"), bank, null).kind).toBe("needs_you");
    expect(answerFor(field("Anything else?", "textarea", [], false), bank, null).kind).toBe("skip");
  });
  it("picks EEO options without false matches", () => {
    expect(pickOption(["Female", "Male", "Decline to self-identify"], ["male"])).toBe("Male");
    expect(pickOption(["Yes, I have a disability", "No, I do not have a disability and have not had one in the past", "I do not want to answer"], [bank.voluntary_self_identification.disability.toLowerCase()])).toMatch(/^No, I do not/);
    expect(pickOption(["I identify as one or more of the classifications of protected veteran", "I am not a protected veteran", "I don't wish to answer"], ["i am not a protected veteran"])).toBe("I am not a protected veteran");
    expect(pickOption(["Asian (Not Hispanic or Latino)", "White (Not Hispanic or Latino)"], ["asian"])).toBe("Asian (Not Hispanic or Latino)");
    expect(pickOption(["I don't wish to answer", "No"], ["no"])).toBe("No");
  });
});

describe("confirmation emails", () => {
  it.each([
    ["Thank you for applying to Stripe!", "", { company: "Stripe" }],
    ["Your application for Software Engineer at Acme Corp", "", { company: "Acme Corp", title: "Software Engineer" }],
    ["Thanks for your interest in Datadog", "", { company: "Datadog" }],
    ["Application received", "\"Ramp Recruiting\" <no-reply@hire.lever.co>", { company: "Ramp" }],
  ])("%s", (subject, from, expected) => expect(parseConfirmation(subject, from, "")).toMatchObject(expected));
});

describe("what the AI may answer", () => {
  const f = (label: string, kind: Field["kind"] = "text") => ({ id: "x", label, kind, options: [], required: true }) as Field;
  it("answers experience questions the bank doesn't cover", async () => {
    const { aiMayAnswer } = await import("../src/forms/answers.js");
    expect(aiMayAnswer(null, f("Do you have experience with full lifecycle product development?", "combobox"))).toBe(true);
    expect(aiMayAnswer(null, f("Do you have experience with system design?", "radio"))).toBe(true);
    expect(aiMayAnswer(null, f("Do you have experience with distributed tracing?", "radio"))).toBe(true);
    expect(aiMayAnswer("years_experience", f("How many years of experience with Kubernetes?"))).toBe(true);
    expect(aiMayAnswer(null, f("Why do you want to work at Acme?", "textarea"))).toBe(true);
  });
  it("leaves only the 'only you' questions alone", async () => {
    const { aiMayAnswer } = await import("../src/forms/answers.js");
    expect(aiMayAnswer("criminal_history", f("Have you been convicted?", "radio"))).toBe(false);
    expect(aiMayAnswer("agreements", f("Are you bound by a non-compete?", "radio"))).toBe(false);
    expect(aiMayAnswer("auth_expiry", f("When does your EAD expire?"))).toBe(false);
    expect(aiMayAnswer("pronouns", f("Pronouns", "select"))).toBe(false);
    expect(aiMayAnswer(null, f("Please type your full name as your electronic signature"))).toBe(false);
    expect(aiMayAnswer(null, f("I consent to background verification", "checkbox"))).toBe(false);
    // Everything else may be filled (from the bank's facts when it's about them).
    expect(aiMayAnswer("salary", f("Expected compensation range?", "select"))).toBe(true);
    expect(aiMayAnswer("sponsorship", f("Will you require sponsorship?", "select"))).toBe(true);
    expect(aiMayAnswer(null, f("Sexual orientation", "select"))).toBe(true);
  });
});

describe("fixes from the first dry run", () => {
  const skip = (title: string, text = "3+ years of software engineering experience", company = "Acme") => hardSkip({ title, company, text }, bank);
  it("skips export-controlled roles", () => {
    expect(skip("Software Engineer", "3+ years of experience. To conform to U.S. Government export regulations, applicant must be a U.S. person (ITAR).")).toMatch(/export-controlled/);
  });
  it("skips off-target titles, new-grad programs and aggregators", () => {
    expect(skip("Enterprise Account Executive, Growth")).toMatch(/not a backend/);
    expect(skip("Security Engineer III")).toMatch(/not a backend/);
    expect(skip("Backend Software Engineer - University Graduate 2027")).toMatch(/new-grad/);
    expect(skip("Software Engineer", undefined, "Jobgether")).toMatch(/do-not-apply/);
    expect(skip("Full Stack Engineer (Application Software)")).toBeNull();
    expect(skip("Platform Engineer, Cloud")).toBeNull();
  });
  it("routes the questions that went wrong", () => {
    expect(matchRule("GPA (Undergraduate)")).toBe("gpa");
    expect(matchRule("GPA (Graduate)")).toBe("gpa");
    expect(matchRule("GRE Score")).toBe("standardized_tests");
    expect(matchRule("Do you have experience with event-driven systems?")).toBe(null);
    expect(matchRule("Graduation year")).toBe("graduation");
    expect(matchRule("Are you subject to any employment agreements and/or post-employment restrictions with your current employer?")).toBe("agreements");
    expect(matchRule("Do you currently hold employment authorization that is temporary or subject to expiration (such as TN, H-1B, F-1 OPT)?")).toBe("temporary_authorization");
    expect(matchRule("What is the expiration date of your EAD?")).toBe("auth_expiry");
    expect(matchRule("Opt In to receive text message updates about your application.")).toBe("sms_consent");
    expect(matchRule("By submitting my application, I acknowledge that I have read and understand Acme's Job Applicant Privacy Notice")).toBe("acknowledgement");
  });
  it("answers them from the bank", () => {
    expect(answerFor(field("GPA (Undergraduate)", "combobox"), bank, "gpa")).toEqual({ kind: "choice", prefer: ["3.4", "3.4 out of 4.0", "3.4/4.0"] });
    expect(answerFor(field("GPA (Graduate)"), bank, "gpa")).toEqual({ kind: "text", value: "3.8" });
    expect(answerFor(field("SAT Score", "combobox"), bank, "standardized_tests").kind).toBe("choice");
    expect(answerFor(field("GRE Score", "combobox"), bank, "standardized_tests")).toEqual({ kind: "choice", prefer: ["320"] });
    expect(answerFor(field("Temporary authorization?", "select", ["Yes", "No"]), bank, "temporary_authorization")).toEqual({ kind: "choice", prefer: ["yes"] });
    expect(answerFor(field("Opt in to texts?", "select", ["Yes", "No"]), bank, "sms_consent")).toMatchObject({ kind: "choice", prefer: expect.arrayContaining(["no"]) });
    expect(pickOption(["Acknowledge/Confirm"], (answerFor(field("I acknowledge the privacy notice", "select", ["Acknowledge/Confirm"]), bank, "acknowledgement") as { prefer: string[] }).prefer)).toBe("Acknowledge/Confirm");
  });
});

describe("security codes and look-alike options", () => {
  it("reads Greenhouse-style codes", async () => {
    const { extractCode } = await import("../src/gmail.js");
    expect(extractCode("Copy and paste this code into the security code field on your application: Xk3pQ9aB")).toBe("Xk3pQ9aB");
    expect(extractCode("Your verification code is 482913. It expires in 10 minutes.")).toBe("482913");
    expect(extractCode("Enter the security code from your email")).toBeNull();
  });
  it("prefers the U.S. option and refuses to guess between foreign ones", () => {
    expect(pickOption(["Yes, Netherlands Highly Skilled Migrant Visa", "Yes, US H-1B Visa", "No"], ["yes"])).toBe("Yes, US H-1B Visa");
    expect(pickOption(["Yes, Netherlands visa", "Yes, Canada permit", "No"], ["yes"])).toBeNull();
    expect(pickOption(["Yes", "No"], ["yes"])).toBe("Yes");
  });
});

describe("questions seen on real forms", () => {
  it("sponsorship prefers 'in the future' when the form separates now and later", () => {
    const a = answerFor(field("Will you require sponsorship?", "select", ["Yes, now", "Yes, in the future", "No"]), bank, "sponsorship") as { prefer: string[] };
    expect(pickOption(["Yes, now", "Yes, in the future", "No"], a.prefer)).toBe("Yes, in the future");
    expect(pickOption(["Yes", "No"], a.prefer)).toBe("Yes");
  });
  it("answers relatives with No, and no longer stops on it", async () => {
    const { aiMayAnswer } = await import("../src/forms/answers.js");
    expect(answerFor(field("Do you have any relatives or close personal friends who work at Acme?", "select", ["Yes", "No"]), bank, "relatives")).toEqual({ kind: "choice", prefer: ["no"] });
    expect(answerFor(field("Relatives at the company? If yes, please list", "text"), bank, "relatives")).toEqual({ kind: "text", value: "No" });
    expect(aiMayAnswer("relatives", field("Relatives here?", "select"))).toBe(true);
  });
});

describe("choosing the right security code (back-to-back applications)", () => {
  const at = (s: number) => Date.UTC(2026, 10, 6, 3, 36, s);
  const email = (id: string, s: number, company: string, code: string) => ({ id, receivedAt: at(s), text: `Security code for your application to ${company}. Copy and paste this code into the security code field on your application: ${code}` });
  it("never uses the previous job's code, even seconds apart", async () => {
    const { chooseCode } = await import("../src/gmail.js");
    const emails = [email("a", 30, "Globex", "67042867"), email("b", 58, "Acme", "Ab12Cd34")];
    expect(chooseCode(emails, { since: new Date(at(50)), company: "Acme", used: new Set() })?.code).toBe("Ab12Cd34");
    // Acme's email hasn't arrived yet: Globex's (before the click) is never taken.
    expect(chooseCode([emails[0]], { since: new Date(at(50)), company: "Acme", used: new Set() })).toBeNull();
  });
  it("prefers the email naming this company when two arrive together", async () => {
    const { chooseCode } = await import("../src/gmail.js");
    const emails = [email("a", 55, "Initech", "11112222"), email("b", 56, "Acme", "33334444")];
    expect(chooseCode(emails, { since: new Date(at(50)), company: "Initech", used: new Set() })?.code).toBe("11112222");
  });
  it("never reuses a code", async () => {
    const { chooseCode } = await import("../src/gmail.js");
    const emails = [email("a", 55, "Umbrella", "55556666"), email("b", 57, "Umbrella", "77778888")];
    expect(chooseCode(emails, { since: new Date(at(50)), company: "Umbrella", used: new Set(["77778888"]) })?.code).toBe("55556666");
    expect(chooseCode(emails, { since: new Date(at(50)), company: "Umbrella", used: new Set(["77778888", "55556666"]) })).toBeNull();
  });
  it("matches 'name you'd prefer us to use' to the preferred name", () => {
    expect(matchRule("What's the name you'd prefer us to use throughout the interview process?")).toBe("preferred_name");
  });
});

describe("reading codes without picking up words", () => {
  it("takes the code, not the company name", async () => {
    const { extractCode } = await import("../src/gmail.js");
    expect(extractCode("Security code for your application to Acme. Copy and paste this code into the security code field on your application: AbCdEfGh")).toBe("AbCdEfGh");
    expect(extractCode("Security code for your application to Acme. Your code is 67042867")).toBe("67042867");
    expect(extractCode("Security code for your application to Acme")).toBeNull();
  });
});

describe("real application questions, in their exact wording", () => {
  const ask = (label: string, kind: Field["kind"] = "select", options = ["Yes", "No"]) => {
    const f = field(label, kind, options);
    const answer = answerFor(f, bank, matchRule(label));
    return answer.kind === "choice" ? pickOption(options, answer.prefer) : answer.kind === "text" ? answer.value : answer.kind;
  };
  it.each([
    ["Are you subject to any employment agreements and/or post-employment restrictions with your current employer or a past employer?", "No"],
    ["Are you subject to any restrictive covenants (e.g., non-compete or non-solicitation agreements)?", "No"],
    ["Have you built an automation or workflow where AI takes an input, processes it, and produces an output or triggers another action?", "Yes"],
    ["This role requires a hybrid work schedule, with 3 days per week in the office at the specified location in the description. Are you willing, and able to work on this schedule for this role?", "Yes"],
    ["This role is designated as on-site and requires working from the office five days per week. Can you meet this requirement?", "Yes"],
    ["Are you able to provide proof of your legal work authorization?", "Yes"],
    ["Will you in future require visa sponsorship to maintain work authorization?", "Yes"],
    ["Do you now require visa sponsorship for employment?", "No"],
    ["Will you now or in the future require sponsorship for employment visa status?", "Yes"],
    ["Do you require a visa sponsorship?", "Yes"],
    ["Are you a collector?", "No"],
  ])("%s → %s", (label, expected) => expect(ask(label)).toBe(expected));

  it("accessibility adjustments: No", () => {
    expect(ask("It is important to us to create an accessible and inclusive interview experience. Please let us know if there are any adjustments we can make to assist you during the hiring and interview process.", "text", [])).toBe("No");
  });
  it("AI tools: Claude API", () => {
    expect(ask("Which of the following have you personally used to build or integrate an AI solution?", "checkboxes", ["OpenAI API", "Claude API", "Gemini API", "Other"])).toBe("Claude API");
    expect(ask("Which of the following have you personally used to build or integrate an AI solution?", "text", [])).toBe("Claude API");
  });
  it("an explanation of the AI automation leaves a Draft", () => {
    expect(ask("Have you built an automation or workflow where AI takes an input, processes it, and produces an output or triggers another action? Please explain.", "textarea", [])).toBe("needs_you");
  });
  it("the optional 'what do you collect' box stays blank", () => {
    expect(matchRule("If you collect trading cards, please tell us what you collect.")).not.toBe("collector");
  });
});

describe("consent boxes never block", () => {
  it("ticks bare consent boxes and picks consent options", () => {
    expect(matchRule("Yes, I consent.")).toBe("consent");
    expect(answerFor(field("Yes, I consent.", "checkbox"), bank, "consent")).toEqual({ kind: "check" });
    expect(answerFor(field("I agree", "checkbox"), bank, matchRule("I agree"))).toEqual({ kind: "check" });
    expect(pickOption(["Yes, I consent", "No"], (answerFor(field("Consent", "select", ["Yes, I consent", "No"]), bank, "consent") as { prefer: string[] }).prefer)).toBe("Yes, I consent");
  });
  it("still leaves certifications and signatures to you", () => {
    expect(answerFor(field("I certify and agree that my electronic signature is binding", "checkbox"), bank, "consent").kind).toBe("needs_you");
  });
});

describe("company career pages with ?gh_jid= (company career pages)", () => {
  it("finds the Greenhouse board name from the page, else from the address", async () => {
    const { greenhouseBoardGuesses } = await import("../src/forms/ats.js");
    expect(greenhouseBoardGuesses('<script src="https://boards.greenhouse.io/embed/job_board/js?for=acmeinc"></script>', "https://www.acme.com/careers/job/1234567?gh_jid=1234567")[0]).toBe("acmeinc");
    expect(greenhouseBoardGuesses("", "https://www.initech.com/careers/apply?gh_jid=7654321")).toContain("initech");
    expect(greenhouseBoardGuesses("", "https://cms.globex-corp.com/company/job-listing?gh_jid=1111111111")).toContain("globexcorp");
  });
});

describe("cover letter setting", () => {
  it("attaches to optional uploads only when set to always", async () => {
    const { answerFor, matchRule } = await import("../src/forms/answers.js");
    const { loadAnswerBank } = await import("../src/config.js");
    const bank = loadAnswerBank();
    expect(matchRule("Portfolio or Cover Letter")).toBeTruthy();
    const field = { id: "c", kind: "file", label: "Cover Letter", required: false, options: [] } as any;
    expect(answerFor(field, { ...bank, documents: { ...bank.documents, cover_letter: "always" } }, "cover_letter")).toEqual({ kind: "file", which: "cover_letter" });
    expect(answerFor(field, { ...bank, documents: { ...bank.documents, cover_letter: "only_when_required" } }, "cover_letter")).toEqual({ kind: "skip" });
    expect(answerFor({ ...field, kind: "textarea" }, { ...bank, documents: { ...bank.documents, cover_letter: "always" } }, "cover_letter")).toEqual({ kind: "skip" });
  });
});

describe("certification that the application is accurate", () => {
  it("is confirmed, not mistaken for the resume upload", async () => {
    const { matchRule, answerFor, aiMayAnswer } = await import("../src/forms/answers.js");
    const { loadAnswerBank } = await import("../src/config.js");
    const label = "I certify that the information provided in my application, resume, and responses to application questions is accurate and complete to the best of my knowledge. I understand that providing false, misleading, or materially inaccurate information may result in my application being withdrawn or, if hired, may result in termination of employment.*";
    const key = matchRule(label);
    expect(key).toBe("acknowledgement");
    expect(answerFor({ id: "x", kind: "select", label, required: true, options: ["Yes"] } as any, loadAnswerBank(), key)).toMatchObject({ kind: "choice" });
    expect(answerFor({ id: "x", kind: "checkbox", label, required: true, options: [] } as any, loadAnswerBank(), key)).toEqual({ kind: "check" });
    expect(matchRule("Resume/CV")).toBe("resume");
    expect(aiMayAnswer("acknowledgement", { label } as any)).toBe(true);
    expect(aiMayAnswer(null, { label: "Signature (type your full name)" } as any)).toBe(false);
  });
});

describe("race questions that split a race into subgroups", () => {
  it("matches 'racial/ethnic background' and prefers race_detail when set", async () => {
    const { matchRule, answerFor } = await import("../src/forms/answers.js");
    const { loadAnswerBank } = await import("../src/config.js");
    const bank = loadAnswerBank();
    const label = "How would you describe your racial/ethnic background? (mark all that apply)";
    expect(matchRule(label)).toBe("race");
    const f = { id: "r", kind: "checkbox", label, required: false, options: ["East Asian", "South Asian", "Southeast Asian", "White", "I don't wish to answer"] } as any;
    const withDetail = { ...bank, voluntary_self_identification: { ...bank.voluntary_self_identification, race_detail: "South Asian" } };
    expect(answerFor(f, withDetail, "race")).toMatchObject({ kind: "choice", prefer: ["south asian", bank.voluntary_self_identification.race.toLowerCase()] });
  });
});

describe("saved answers that hand a question to the AI", () => {
  it("recognises them, and nothing else", async () => {
    const { meansLetAi } = await import("../src/saved-answers.js");
    for (const yes of ["ai", "AI", "Ask the AI to write the answer", "Write an appropriate answer based on my profile", "let claude answer", "use the AI"]) expect(meansLetAi(yes)).toBe(true);
    for (const no of ["No", "Yes", "Careers Website", "3-5 years", "I build AI tools at work daily"]) expect(meansLetAi(no)).toBe(false);
  });
  it("guesses Greenhouse boards from the company name", async () => {
    const { greenhouseBoardGuesses } = await import("../src/forms/ats.js");
    expect(greenhouseBoardGuesses("", "https://careers.acmetab.com/jobs?gh_jid=1", "Acme")).toContain("acme");
    expect(greenhouseBoardGuesses("", "https://www.globex.com/job-posting?gh_jid=1", "Globex, Inc.")).toEqual(expect.arrayContaining(["globexinc", "globex"]));
  });
});

describe("Ashby links and job-board reposts", () => {
  it("identifies Ashby jobs and their application page", async () => {
    const { identify, isRepost } = await import("../src/select/canonical.js");
    const job = identify("https://jobs.ashbyhq.com/acme/0b6f4f43-1d0e-4c6e-9d3a-5c1f0e2b7a11?utm_source=x");
    expect(job).toMatchObject({ site: "ashby", key: "ashby:acme:0b6f4f43-1d0e-4c6e-9d3a-5c1f0e2b7a11", applyUrl: "https://jobs.ashbyhq.com/acme/0b6f4f43-1d0e-4c6e-9d3a-5c1f0e2b7a11/application" });
    expect(identify("https://careers.acme.com/jobs?ashby_jid=0b6f4f43-1d0e-4c6e-9d3a-5c1f0e2b7a11")?.site).toBe("ashby");
    expect(identify("https://careers.acme.com/jobs/123")?.site).toBe("other");
    expect(isRepost("https://www.adzuna.com/details/123")).toBe(true);
    expect(isRepost("https://www.whatjobs.com/job/1")).toBe(true);
    expect(isRepost("https://careers.acme.com/jobs/123")).toBe(false);
  });
});

describe("error messages", () => {
  it("are one plain line without Playwright's call log or colour codes", async () => {
    const { short } = await import("../src/errors.js");
    const raw = 'Error: page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://careers.acme.com/jobs/1\nCall log:\n\u001b[2m  - navigating to "https://careers.acme.com/jobs/1", waiting until "domcontentloaded"\u001b[22m\n';
    const line = short(raw);
    expect(line).toMatch(/^the site dropped the connection/);
    expect(line).not.toMatch(/Call log|\u001b|\[2m|\n/);
    expect(short(new Error("Couldn't find the application form on this page"))).toBe("Couldn't find the application form on this page");
  });
});
