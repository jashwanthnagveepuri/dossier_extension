import type { Frame, Locator } from "playwright";

import type { Answer, Field, FieldKind } from "./answers.js";
import { pickOption } from "./answers.js";

// Reads any application form into a list of labelled fields, and fills a field
// with an answer. Works from labels rather than per-site ids, so the same code
// handles Greenhouse, Lever and most hand-built career pages.

/**
 * tsx (via esbuild) wraps named functions in __name(), including the ones this
 * file sends into the page with evaluate(). The page has no __name, so give it a
 * do-nothing one. Added to every page the applier opens (see run.ts).
 */
export const PAGE_SHIM = "globalThis.__name = globalThis.__name || function (f) { return f; };";

type RawField = { id: string; kind: FieldKind; label: string; required: boolean; options: string[]; name?: string };

/** Every fillable field inside `rootSelector`, in page order. */
export async function readFields(frame: Frame, rootSelector: string): Promise<Field[]> {
  const raw = await frame.evaluate((rootSel: string): RawField[] => {
    const root = document.querySelector(rootSel) ?? document.body;
    const clean = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();
    const visible = (el: Element) => {
      const box = (el as HTMLElement).getBoundingClientRect();
      const style = getComputedStyle(el as HTMLElement);
      return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const textOf = (el: Element | null) => clean((el as HTMLElement | null)?.innerText ?? el?.textContent);
    // Numbering continues across reads, so a question that appears later never reuses an earlier field's id.
    const store = window as unknown as { __applierCounter?: number };
    const tag = (el: Element) => {
      const existing = el.getAttribute("data-applier-id");
      if (existing) return existing;
      store.__applierCounter = (store.__applierCounter ?? 0) + 1;
      const id = `f${store.__applierCounter}`;
      el.setAttribute("data-applier-id", id);
      return id;
    };

    /** The question an element belongs to: its label, else the nearest question text around it. */
    const questionOf = (el: Element, group: boolean): string => {
      const labelled = el.getAttribute("aria-labelledby");
      if (labelled && !group) {
        const text = labelled.split(/\s+/).map((id) => textOf(document.getElementById(id))).join(" ");
        if (clean(text)) return clean(text);
      }
      if (!group) {
        const labels = (el as HTMLInputElement).labels;
        if (labels && labels.length) return clean(Array.from(labels).map((label) => textOf(label)).join(" "));
        const aria = el.getAttribute("aria-label");
        if (aria) return clean(aria);
      }
      let node: Element | null = el.parentElement;
      for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
        const legend = node.querySelector(":scope > legend, :scope > .application-label, :scope > label:not(:has(input)), :scope > [class*='label']:not(:has(input)), :scope > [class*='question-text'], :scope > p");
        if (legend && textOf(legend)) return textOf(legend);
        if (node.tagName === "FORM") break;
      }
      return clean(el.getAttribute("placeholder") || el.getAttribute("name") || "");
    };
    // Some sites mark required questions only with a class on the label (Ashby: "_required_…").
    const labelMarked = (el: Element) => {
      const labels = Array.from((el as HTMLInputElement).labels ?? []);
      const near = el.closest("fieldset, [class*='field' i], [class*='question' i]");
      return labels.some((l) => /required/i.test(l.className)) || Boolean(near?.querySelector(":scope > label[class*='required' i], :scope > legend[class*='required' i], :scope > [class*='label' i][class*='required' i]"));
    };
    const isRequired = (el: Element, label: string) =>
      (el as HTMLInputElement).required || el.getAttribute("aria-required") === "true" || /[*✱]\s*$|\(required\)/i.test(label) || labelMarked(el);

    const out: RawField[] = [];
    const groups = new Map<string, HTMLInputElement[]>();
    for (const el of Array.from(root.querySelectorAll("input, textarea, select, [role='combobox']"))) {
      const input = el as HTMLInputElement;
      const type = (input.type || "").toLowerCase();
      if (el.closest("[data-applier-ignore]")) continue;
      if (["hidden", "submit", "button", "reset", "image", "search"].includes(type)) continue;
      // React-select keeps an invisible required <input aria-hidden tabindex=-1> next to each dropdown; it isn't a question.
      if (type !== "file" && (el.getAttribute("aria-hidden") === "true" || (el.getAttribute("tabindex") === "-1" && /requiredInput/i.test(el.className)))) continue;
      if (type !== "file" && !visible(el) && !(type === "radio" || type === "checkbox")) continue;
      // Custom-styled radios and checkboxes hide the input itself, but a whole section that isn't displayed
      // (the next page of a multi-page application) hides its label or fieldset too: those wait for their page.
      if ((type === "radio" || type === "checkbox") && el.getClientRects().length === 0) {
        const holder = el.closest("label, fieldset") ?? el.parentElement;
        if (!holder || holder.getClientRects().length === 0) continue;
      }
      if ((type === "radio" || type === "checkbox") && input.name) {
        const key = `${type}:${input.name}`;
        groups.set(key, [...(groups.get(key) ?? []), input]);
        continue;
      }
      const role = el.getAttribute("role");
      const kind: FieldKind =
        el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "textarea" : role === "combobox" ? "combobox" : type === "file" ? "file" : type === "checkbox" ? "checkbox" : (["email", "tel", "url", "number", "date"].includes(type) ? type : "text") as FieldKind;
      let label = questionOf(el, false);
      // Upload inputs are often labelled just "Attach"; the question ("Resume/CV") is on the group around them.
      if (/^(attach|upload|browse|choose( a)? file|select( a)? file|drop files?.*)$/i.test(label)) {
        const group = el.closest("[role='group'][aria-labelledby], [aria-labelledby]");
        const groupLabel = group?.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => textOf(document.getElementById(id))).join(" ");
        label = clean(groupLabel) || questionOf(el, true) || label;
      }
      const options = kind === "select" ? Array.from((el as HTMLSelectElement).options).map((option) => clean(option.text)) : [];
      out.push({ id: tag(el), kind, label, required: isRequired(el, label), options, name: input.name || undefined });
    }
    for (const [key, inputs] of groups) {
      const first = inputs[0];
      const kind: FieldKind = key.startsWith("radio") ? "radio" : inputs.length > 1 ? "checkboxes" : "checkbox";
      const optionText = (input: HTMLInputElement) => clean(Array.from(input.labels ?? []).map((label) => textOf(label)).join(" ") || input.value);
      const label = kind === "checkbox" ? questionOf(first, false) || questionOf(first, true) : questionOf(first, true);
      inputs.forEach((input) => input.setAttribute("data-applier-option", optionText(input)));
      const groupId = tag(first);
      inputs.forEach((input) => input.setAttribute("data-applier-group", groupId));
      out.push({
        id: groupId,
        kind,
        label,
        required: inputs.some((input) => input.required || input.getAttribute("aria-required") === "true" || labelMarked(input)) || /[*✱]\s*$|\(required\)/i.test(label),
        options: kind === "checkbox" ? [] : inputs.map(optionText),
        name: first.name,
      });
    }
    return out;
  }, rootSelector);
  return raw.map((field) => ({ ...field, label: field.label.replace(/[*✱]/g, "").trim() }));
}

export type FillResult = { field: Field; ok: boolean; detail?: string };

/** Puts one answer into one field. Never types anything that isn't the answer. */
/**
 * Ticks a checkbox or radio. Sites often move the real input off-screen and draw their own,
 * so after a normal check it falls back to its label, then to a script click (which fires the
 * same events a person's click does).
 */
async function tick(frame: Frame, box: Locator): Promise<void> {
  await box.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);
  if (await box.check({ force: true, timeout: 4_000 }).then(() => true, () => false)) return;
  const id = await box.getAttribute("id").catch(() => null);
  const label = id ? frame.locator(`label[for="${id.replace(/"/g, '\\"')}"]`).first() : box.locator("xpath=ancestor::label[1]");
  if ((await label.count()) && (await label.click({ timeout: 3_000 }).then(() => true, () => false)) && (await box.isChecked().catch(() => false))) return;
  await box.evaluate((el) => {
    const input = el as HTMLInputElement;
    if (!input.checked) input.click();
  });
  if (!(await box.isChecked().catch(() => false))) throw new Error("the box wouldn't tick");
}

/**
 * The field(s) for a question named in words (a site's "Missing entry for required field: …"),
 * found by its text on the page: the question's own inputs, as one field marked required.
 */
export async function fieldsForQuestion(frame: Frame, question: string): Promise<Field[]> {
  const found = await frame.evaluate((q: string) => {
    const clean = (s: string) => s.replace(/\s+/g, " ").trim();
    const start = clean(q).slice(0, 45).toLowerCase();
    const holders = Array.from(document.querySelectorAll("label, legend, p, span, div, h3, h4")).filter((el) => {
      const text = clean((el as HTMLElement).innerText || "").toLowerCase();
      return text.startsWith(start) && text.length < q.length + 60;
    });
    const textEl = holders.find((el) => !holders.some((other) => other !== el && el.contains(other)));
    if (!textEl) return null;
    const fieldsIn = (node: Element) => Array.from(node.querySelectorAll("input:not([type='hidden']):not([type='submit']):not([type='button']), select, textarea, [role='combobox']")).filter((f) => !textEl.contains(f) || textEl.tagName === "LABEL");
    let root: Element | null = textEl;
    for (let depth = 0; root && depth < 6 && fieldsIn(root).length === 0; depth++) root = root.parentElement;
    if (!root) return null;
    const inputs = fieldsIn(root) as HTMLInputElement[];
    const store = window as unknown as { __applierCounter?: number };
    const tag = (el: Element) => {
      const existing = el.getAttribute("data-applier-id");
      if (existing) return existing;
      store.__applierCounter = (store.__applierCounter ?? 0) + 1;
      el.setAttribute("data-applier-id", `f${store.__applierCounter}`);
      return `f${store.__applierCounter}`;
    };
    const boxes = inputs.filter((i) => i.type === "checkbox" || i.type === "radio");
    if (boxes.length > 0) {
      const optionText = (i: HTMLInputElement) => clean(Array.from(i.labels ?? []).map((l) => l.innerText).join(" ") || (i.parentElement as HTMLElement | null)?.innerText || i.value);
      const groupId = `q${tag(boxes[0])}`;
      boxes.forEach((b) => {
        b.setAttribute("data-applier-group", groupId);
        b.setAttribute("data-applier-option", optionText(b));
      });
      return { id: groupId, kind: boxes[0].type === "radio" ? "radio" : boxes.length > 1 ? "checkboxes" : "checkbox", options: boxes.map(optionText) };
    }
    const first = inputs[0];
    const kind = first.tagName === "SELECT" ? "select" : first.tagName === "TEXTAREA" ? "textarea" : first.getAttribute("role") === "combobox" ? "combobox" : "text";
    return { id: tag(first), kind, options: first.tagName === "SELECT" ? Array.from((first as unknown as HTMLSelectElement).options).map((o) => clean(o.text)).filter(Boolean) : [] };
  }, question);
  if (!found) return [];
  return [{ id: found.id, kind: found.kind as FieldKind, label: question, required: true, options: found.options }];
}

export async function fill(frame: Frame, field: Field, answer: Answer, files: { resume: string; cover_letter?: string }): Promise<FillResult> {
  const el = frame.locator(`[data-applier-id="${field.id}"]`).first();
  try {
    switch (answer.kind) {
      case "skip":
        return { field, ok: true, detail: "left blank" };
      case "needs_you":
        return { field, ok: false, detail: answer.why };
      case "file": {
        const path = answer.which === "resume" ? files.resume : files.cover_letter;
        if (!path) return { field, ok: false, detail: "cover letter needed but not available" };
        await el.setInputFiles(path);
        return { field, ok: true };
      }
      case "text":
        if (field.kind === "combobox") return await chooseInCombobox(frame, el, field, [answer.value.toLowerCase()], answer.value);
        if (["select", "radio", "checkboxes", "checkbox"].includes(field.kind)) return { field, ok: false, detail: "a text answer for a choice field" };
        await el.fill(answer.value);
        return { field, ok: true };
      case "choices": {
        // Several boxes may apply (a location preference): tick every option the answer allows.
        const allowed = (option: string) => answer.include.some((r) => r.test(option)) && !answer.exclude.some((r) => r.test(option));
        if (field.kind === "checkboxes" || field.kind === "checkbox") {
          const boxes = field.kind === "checkboxes" ? frame.locator(`[data-applier-group="${field.id}"]`) : el;
          const picked: string[] = [];
          for (let i = 0; i < (await boxes.count()); i++) {
            const box = boxes.nth(i);
            const option = (await box.getAttribute("data-applier-option")) ?? field.label;
            if (allowed(option)) {
              await tick(frame, box);
              picked.push(option);
            }
          }
          return picked.length ? { field, ok: true, detail: picked.join(", ") } : { field, ok: !field.required, detail: "none of the options fit" };
        }
        const prefer = field.options.filter(allowed).map((o) => o.toLowerCase());
        if (["select", "radio", "combobox"].includes(field.kind)) return fill(frame, field, { kind: "choice", prefer: prefer.length ? prefer : answer.fallback.map((o) => o.toLowerCase()) }, files);
        return fill(frame, field, { kind: "text", value: answer.text }, files);
      }
      case "check":
        if (field.kind === "checkbox") {
          await tick(frame, el);
          return { field, ok: true };
        }
        if (field.kind === "checkboxes") {
          const boxes = frame.locator(`[data-applier-group="${field.id}"]`);
          for (let i = 0; i < (await boxes.count()); i++) await tick(frame, boxes.nth(i));
          return { field, ok: true };
        }
        return { field, ok: false, detail: "a checkbox answer for another field" };
      case "choice":
        return await choose(frame, el, field, answer.prefer);
    }
  } catch (error) {
    return { field, ok: false, detail: `couldn't fill: ${String(error).slice(0, 160)}` };
  }
}

async function choose(frame: Frame, el: Locator, field: Field, prefer: string[]): Promise<FillResult> {
  if (field.kind === "select") {
    const option = pickOption(field.options, prefer);
    if (!option) return { field, ok: false, detail: `no matching option among ${JSON.stringify(field.options.slice(0, 8))}` };
    await el.selectOption({ label: option });
    return { field, ok: true, detail: option };
  }
  if (field.kind === "radio" || field.kind === "checkboxes") {
    const option = pickOption(field.options, prefer);
    if (!option) return { field, ok: false, detail: `no matching option among ${JSON.stringify(field.options.slice(0, 8))}` };
    const target = frame.locator(`[data-applier-group="${field.id}"][data-applier-option="${option.replace(/"/g, '\\"')}"]`).first();
    await tick(frame, target);
    return { field, ok: true, detail: option };
  }
  if (field.kind === "combobox") return chooseInCombobox(frame, el, field, prefer, null);
  if (field.kind === "checkbox") {
    // A single box like "Yes, I am authorized": tick it only for a yes.
    if (prefer[0] === "yes") {
      await tick(frame, el);
      return { field, ok: true, detail: "checked" };
    }
    return { field, ok: true, detail: "left unchecked" };
  }
  return { field, ok: false, detail: "a choice answer for a text field" };
}

/** React-style dropdowns (Greenhouse's newer boards): open, optionally type, pick a listed option. */
async function chooseInCombobox(frame: Frame, el: Locator, field: Field, prefer: string[], typed: string | null): Promise<FillResult> {
  // "Take the first search result" is only for free-text answers (a city, a school), never for
  // yes/no or picking between look-alike options: there an unclear match must stay unanswered.
  const freeText = typed !== null || (!/^(yes|no)\b/i.test(prefer[0] ?? "") && (prefer[0] ?? "").trim().split(/\s+/).length >= 2);
  const firstResult = (list: string[], query: string | null) =>
    freeText && query && list.length && list[0].toLowerCase().includes(query.split(",")[0].toLowerCase()) ? list[0] : null;
  // Something can sit on top of a dropdown (a popup, a sticky header); then open it from the keyboard.
  await el.click({ timeout: 5_000 }).catch(async () => {
    await el.focus();
    await el.press("ArrowDown");
  });
  if (typed) await el.fill(typed);
  // Only this dropdown's options: another dropdown's list may still be open on the page.
  const options = frame.locator("[data-applier-list] [role='option']");
  const findList = () =>
    el.evaluate((input) => {
      document.querySelectorAll("[data-applier-list]").forEach((node) => node.removeAttribute("data-applier-list"));
      const id = input.getAttribute("aria-controls") || input.getAttribute("aria-owns");
      let list: Element | null = id ? document.getElementById(id) : null;
      // Else the list that belongs to this dropdown: react-select names it after the input's id,
      // otherwise it sits next to the input.
      if (!list && input.id) list = document.querySelector(`[id*="${input.id}"][role='listbox'], [id*="${input.id}-listbox"]`);
      for (let node = input.parentElement, depth = 0; !list && node && depth < 4; node = node.parentElement, depth++) list = node.querySelector("[role='listbox']");
      list?.setAttribute("data-applier-list", "");
    });
  await frame.page().waitForTimeout(300);
  await findList();
  await options.first().waitFor({ state: "visible", timeout: typed ? 8_000 : 4_000 }).catch(() => undefined);
  if (!typed && !(await options.count()) && prefer[0]) {
    // A search box (city, school…) only lists options once something is typed.
    typed = prefer[0];
    await el.fill(typed);
    await options.first().waitFor({ state: "visible", timeout: 8_000 }).catch(() => undefined);
  }
  await findList();
  const texts = (await options.allInnerTexts()).map((text) => text.trim()).filter(Boolean);
  let option = pickOption(texts, prefer) ?? firstResult(texts, typed);
  if (!option && !typed && prefer[0]) {
    // A long list (schools, cities) shows only its first entries until you type.
    typed = prefer[0];
    await el.fill(typed);
    await frame.page().waitForTimeout(800);
    await findList();
    const searched = (await options.allInnerTexts()).map((text) => text.trim()).filter(Boolean);
    texts.splice(0, texts.length, ...searched);
    option = pickOption(searched, prefer) ?? firstResult(searched, typed);
  }
  if (!option) {
    if (typed) await el.fill("").catch(() => undefined); // leave no search text behind for the next attempt
    await el.press("Escape").catch(() => undefined);
    return { field: { ...field, options: texts }, ok: false, detail: `no matching option among ${JSON.stringify(texts.slice(0, 8))}` };
  }
  await options.filter({ hasText: option }).first().click();
  await el.press("Escape").catch(() => undefined); // make sure the list is closed before the next dropdown
  return { field: { ...field, options: texts }, ok: true, detail: option };
}

/** A dropdown's options without choosing one: opens it, reads them, closes it. Other fields already know theirs. */
export async function peekOptions(frame: Frame, field: Field): Promise<string[]> {
  if (field.kind !== "combobox") return field.options;
  const el = frame.locator(`[data-applier-id="${field.id}"]`).first();
  await el.click({ timeout: 5_000 }).catch(async () => {
    await el.focus();
    await el.press("ArrowDown");
  });
  await frame.page().waitForTimeout(400);
  const texts = await el
    .evaluate((input) => {
      const id = input.getAttribute("aria-controls") || input.getAttribute("aria-owns");
      let list: Element | null = id ? document.getElementById(id) : null;
      if (!list && input.id) list = document.querySelector(`[id*="${input.id}"][role='listbox'], [id*="${input.id}-listbox"]`);
      for (let node = input.parentElement, depth = 0; !list && node && depth < 4; node = node.parentElement, depth++) list = node.querySelector("[role='listbox']");
      return list ? Array.from(list.querySelectorAll("[role='option']")).map((option) => (option.textContent ?? "").trim()).filter(Boolean) : [];
    })
    .catch(() => [] as string[]);
  await el.press("Escape").catch(() => undefined);
  return texts;
}
