import type { Frame } from "playwright";

import type { AnswerBank } from "../config.js";
import { sponsorshipAnswer } from "./answers.js";
import type { FillResult } from "./page.js";

// The last check before Submit, independent of how the answers were chosen:
// read back what the page actually shows for every work-authorization,
// sponsorship, visa and citizenship question, and compare it with the answer
// bank. Anything that doesn't match, or can't be read, stops the submit.

const LEGAL = /sponsor|visa|authori[sz]ed to work|work authori[sz]ation|eligible to work|legally (authori[sz]ed|able|permitted)|right to work|citizen|immigration|work permit/i;
const FOREIGN = /netherlands|dutch|canad|united kingdom|\buk\b|britain|german|ireland|irish|india\b|indian|australia|europe|\beu\b|schengen|singapore|japan|mexic|brazil|france|french|spain|poland|israel|uae|dubai|tier 2|skilled worker visa|blue card|highly skilled migrant/i;

/** What the page shows for a field right now: selected option, checked radio, or typed text. */
export async function shownValue(frame: Frame, fieldId: string): Promise<string> {
  return frame
    .evaluate((id) => {
      const el = document.querySelector(`[data-applier-id="${id}"]`) as HTMLInputElement | HTMLSelectElement | null;
      if (!el) return "";
      if (el instanceof HTMLSelectElement) return el.selectedOptions[0]?.textContent?.trim() ?? "";
      if (el.type === "radio" || el.type === "checkbox") {
        const group = document.querySelectorAll(`[data-applier-group="${id}"]`);
        const checked = Array.from(group.length ? group : [el]).filter((node) => (node as HTMLInputElement).checked);
        return checked.map((node) => node.getAttribute("data-applier-option") ?? (node as HTMLInputElement).value).join(", ");
      }
      if (el.getAttribute("role") === "combobox") {
        // React-style dropdowns (Greenhouse) show the choice in a sibling element, a few levels up
        // from the input, and copy it into a hidden required input.
        for (let node: Element | null = el.parentElement, depth = 0; node && depth < 6; node = node.parentElement, depth++) {
          const shown = (node.querySelector("[class*='single-value' i], [class*='singleValue' i]") as HTMLElement | null)?.innerText?.trim();
          if (shown) return shown;
          const hidden = node.querySelector("input[aria-hidden='true'][tabindex='-1']") as HTMLInputElement | null;
          if (hidden?.value?.trim()) return hidden.value.trim();
          if (node.matches("form, [class*='field-wrapper' i], fieldset")) break;
        }
        return el.value.trim();
      }
      return el.value.trim();
    }, fieldId)
    .catch(() => "");
}

/** Problems found, as lines for the report; empty when every legal answer matches the answer bank. */
export async function checkLegalAnswers(frame: Frame, filled: FillResult[], bank: AnswerBank): Promise<string[]> {
  const problems: string[] = [];
  for (const { field, ok, detail } of filled) {
    if (!LEGAL.test(field.label) || field.kind === "file") continue;
    if (!ok && !field.required) continue;
    if (detail === "left blank" && !field.required) continue;
    // What the page shows; if a site's widget can't be read, what the applier itself chose (still checked below).
    const value = (await shownValue(frame, field.id)) || (ok && detail && detail !== "left blank" ? detail : "");
    const label = field.label.slice(0, 90);
    if (!value) {
      if (field.required) problems.push(`legal check: "${label}" shows no answer`);
      continue;
    }
    if (FOREIGN.test(value)) {
      problems.push(`legal check: "${label}" shows "${value.slice(0, 80)}", which is about another country`);
      continue;
    }
    const sponsorship = /sponsor/i.test(field.label) || (/visa/i.test(field.label) && /require|need/i.test(field.label));
    const authorized = !sponsorship && /authori[sz]ed to work|work authori[sz]ation|eligible to work|legally|right to work/i.test(field.label) && !/temporary|expir/i.test(field.label);
    const saysYes = /^\s*(yes|y\b|i (am|will|do)\b|authori[sz]ed|will require|require|in the future|future|at a later)/i.test(value);
    const saysNo = /^\s*(no\b|n\b|i (am not|do not|don't|will not)|not )/i.test(value);
    if (sponsorship) {
      const want = sponsorshipAnswer(field.label, bank);
      if ((want === "Yes" && !saysYes) || (want === "No" && !saysNo)) problems.push(`legal check: sponsorship "${label}" shows "${value.slice(0, 80)}", but your answer is ${want}`);
    } else if (authorized) {
      const want = bank.work_authorization.authorized_to_work_in_us;
      // Some forms fold sponsorship into this question ("I require sponsorship to work in the US"); that's consistent with Yes + sponsorship.
      const consistent = want === "Yes" ? saysYes || /require sponsorship|need sponsorship|with sponsorship|opt|ead/i.test(value) : saysNo;
      if (!consistent) problems.push(`legal check: authorization "${label}" shows "${value.slice(0, 80)}", but your answer is ${want}`);
    }
  }
  return problems;
}
