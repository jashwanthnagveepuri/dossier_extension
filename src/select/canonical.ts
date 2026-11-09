// One identity per job, whatever board it was found on: the ATS's own ids.
// LinkedIn, Indeed and the company's site can all list the same Greenhouse
// job; they share one key here, so it's never applied to twice.

export type Site = "greenhouse" | "lever" | "ashby" | "workday" | "other";
export type JobIdentity = { site: Site; key: string; applyUrl: string };

/**
 * Job boards that repost other companies' jobs. Their Apply buttons lead to sign-ups and
 * redirect chains, not to the employer's form, so they're never applied through.
 */
const REPOST_HOSTS = /(^|\.)(adzuna\.[a-z.]+|whatjobs\.com|himalayas\.app|torre\.ai|jooble\.org|lensa\.com|talent\.com|ziprecruiter\.com|indeed\.com|linkedin\.com|glassdoor\.com|monster\.com|simplyhired\.com|careerbuilder\.com|remotejobs\w*\.\w+|remoteok\.com|weworkremotely\.com|jobgether\.com|talentify\.io|dice\.com|builtin\.com|wellfound\.com|otta\.com)$/i;

/** Whether a link points at a job board's repost rather than the employer. */
export function isRepost(rawUrl: string): boolean {
  try {
    return REPOST_HOSTS.test(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

export function identify(rawUrl: string): JobIdentity | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);

  // boards.greenhouse.io/{board}/jobs/{id}, job-boards.greenhouse.io/{board}/jobs/{id},
  // and the embed form boards.greenhouse.io/embed/job_app?for={board}&token={id}
  if (host.endsWith("greenhouse.io")) {
    if (parts[0] === "embed") {
      const board = url.searchParams.get("for");
      const id = url.searchParams.get("token");
      if (board && id) return greenhouse(board, id);
    }
    const jobs = parts.indexOf("jobs");
    if (jobs > 0 && parts[jobs + 1]) return greenhouse(parts[jobs - 1], parts[jobs + 1].replace(/\D.*$/, ""));
  }
  // A company page with ?gh_jid= embeds a Greenhouse form; the board isn't in the URL.
  const ghJid = url.searchParams.get("gh_jid");
  if (ghJid && /^\d+$/.test(ghJid)) return { site: "greenhouse", key: `greenhouse:?:${ghJid}`, applyUrl: url.toString() };

  // jobs.lever.co/{site}/{uuid}[/apply]
  if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") {
    if (parts[0] && parts[1] && /^[0-9a-f-]{36}$/i.test(parts[1])) {
      return { site: "lever", key: `lever:${parts[0].toLowerCase()}:${parts[1].toLowerCase()}`, applyUrl: `https://${host}/${parts[0]}/${parts[1]}/apply` };
    }
  }

  // jobs.ashbyhq.com/{org}/{uuid}[/application]
  if (host === "jobs.ashbyhq.com" && parts[0] && parts[1] && /^[0-9a-f-]{36}$/i.test(parts[1])) {
    return { site: "ashby", key: `ashby:${parts[0].toLowerCase()}:${parts[1].toLowerCase()}`, applyUrl: `https://jobs.ashbyhq.com/${parts[0]}/${parts[1]}/application` };
  }
  // A company page with ?ashby_jid= embeds an Ashby form.
  const ashbyJid = url.searchParams.get("ashby_jid");
  if (ashbyJid && /^[0-9a-f-]{36}$/i.test(ashbyJid)) return { site: "ashby", key: `ashby:?:${ashbyJid.toLowerCase()}`, applyUrl: url.toString() };

  // {tenant}.wd{n}.myworkdayjobs.com/.../job/.../{title}_{R-12345}
  if (host.endsWith("myworkdayjobs.com") || host.endsWith("myworkdaysite.com")) {
    const tenant = host.split(".")[0];
    const last = parts.at(-1) ?? "";
    const requisition = last.match(/_([A-Z]*-?\d[\w-]*)$/i)?.[1] ?? last;
    return { site: "workday", key: `workday:${tenant}:${requisition.toLowerCase()}`, applyUrl: url.toString() };
  }

  return { site: "other", key: `url:${host}${url.pathname.replace(/\/+$/, "").toLowerCase()}`, applyUrl: url.toString() };
}

function greenhouse(board: string, id: string): JobIdentity {
  return {
    site: "greenhouse",
    key: `greenhouse:${board.toLowerCase()}:${id}`,
    applyUrl: `https://job-boards.greenhouse.io/${board}/jobs/${id}`,
  };
}

/** Whether two identities are the same job (a ?gh_jid= key matches any board with that id). */
export function sameJob(a: string, b: string): boolean {
  if (a === b) return true;
  const [siteA, boardA, idA] = a.split(":");
  const [siteB, boardB, idB] = b.split(":");
  return siteA === siteB && (siteA === "greenhouse" || siteA === "ashby") && idA === idB && (boardA === "?" || boardB === "?");
}
