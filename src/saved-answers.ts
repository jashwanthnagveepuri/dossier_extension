import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parse, stringify } from "yaml";

import { ROOT } from "./config.js";

// Answers you typed for questions the answer bank didn't cover (npm run pending),
// kept in config/my-answers.yaml. "only_for" limits one to a single application.

export type SavedAnswer = { question: string; answer: string; only_for?: string };
const FILE = join(ROOT, "config", "my-answers.yaml");

export const normalizeQuestion = (text: string) => text.toLowerCase().replace(/[*✱]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

export function loadSavedAnswers(): SavedAnswer[] {
  if (!existsSync(FILE)) return [];
  const data = parse(readFileSync(FILE, "utf8")) as { answers?: SavedAnswer[] } | null;
  return (data?.answers ?? []).filter((entry) => entry && entry.question && entry.answer !== undefined).map((entry) => ({ ...entry, answer: String(entry.answer) }));
}

export function saveAnswers(answers: SavedAnswer[]): void {
  const header = "# Your answers to questions the answer bank didn't cover (added by npm run pending).\n# Edit or delete any line. only_for: an application id means it was used for that one application only.\n";
  writeFileSync(FILE, header + stringify({ answers }));
}

/** Your saved answer for this question on this application, if any. */
export function findSaved(answers: SavedAnswer[], question: string, applicationId?: string): SavedAnswer | undefined {
  const wanted = normalizeQuestion(question);
  if (!wanted) return undefined;
  return answers.find((entry) => normalizeQuestion(entry.question) === wanted && (!entry.only_for || entry.only_for === applicationId));
}
