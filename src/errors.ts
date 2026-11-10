// Errors as one readable line: no terminal colour codes, no Playwright call log,
// and a plain-words reason for the network failures career sites cause most.

const PLAIN: [RegExp, string][] = [
  [/ERR_HTTP2_PROTOCOL_ERROR|ERR_CONNECTION_(RESET|CLOSED|REFUSED)|ERR_EMPTY_RESPONSE/, "the site dropped the connection (some career sites block automated browsers; retry later)"],
  [/ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_UNREACHABLE/, "the site's address doesn't resolve (the posting may be gone)"],
  [/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/, "your internet connection dropped"],
  [/ERR_TOO_MANY_REDIRECTS/, "the site kept redirecting (often a sign-in loop)"],
  [/TimeoutError|Timeout \d+ms exceeded/, "the page took too long to respond"],
];

/** One line, at most `max` characters, readable in the report and in npm run pending. */
export function short(error: unknown, max = 220): string {
  const raw = error instanceof Error ? `${error.name === "Error" ? "" : `${error.name}: `}${error.message}` : String(error);
  const text = raw
    .replace(/\u001b\[[0-9;]*m/g, "") // terminal colours
    .replace(/\[\d+m/g, "")
    .split(/\n\s*Call log:/)[0] // Playwright's step-by-step log
    .replace(/^Error:\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  const plain = PLAIN.find(([pattern]) => pattern.test(raw));
  const line = plain ? `${plain[1]} — ${text.replace(/^page\.goto: /, "")}` : text;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
