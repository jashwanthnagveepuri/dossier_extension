# dossier_extension

An auto-apply add-on for [Dossier](https://github.com/AienTech/dossier), the self-hosted job search app.

It runs on your own computer. Every day it finds new jobs through Dossier, skips the ones that break your rules, scores the rest, has Dossier write a tailored resume and cover letter for each one, fills in the Greenhouse or Lever application form in a real browser, and submits it. Dossier stays your one dashboard: **Sent** = applied, **Draft** = waiting on you.

```
Dossier search ──► filter ──► score ──► pick (daily cap) ──► Dossier tailors resume + letter ──► fill form ──► submit ──► Dossier: Sent
                                                                                                    │
                    a question only you can answer / CAPTCHA / error ───────────────────────────────┴──► stays Draft → npm run pending
```

Supports **Greenhouse and Lever** forms (including company career pages that embed them). Workday and other sites are found but skipped for now.

> **Easiest way to set it up:** open [AI_SETUP_PROMPT.md](AI_SETUP_PROMPT.md), copy the prompt into Claude, ChatGPT or any AI assistant, and it walks you through every step below one question at a time, including writing your answer bank for you.

## What it will and won't do

- Answers personal and legal questions (work authorization, sponsorship, salary, location, voluntary self-ID) **only from your `config/answer-bank.yaml`**. Other questions are answered by Claude from your Dossier profile, truthfully.
- Never guesses criminal history, non-competes, authorization end dates, pronouns or signatures: the application waits for you, and `npm run pending` asks you once and remembers the answer.
- Checks every legal answer against your answer bank again just before submitting, and stops if anything contradicts it.
- Never solves or gets around a CAPTCHA.
- Never applies to the same job twice (its own history, Dossier, and confirmation emails in Gmail).
- Skips your do-not-apply companies, and jobs whose posting rules you out (no sponsorship, citizenship, clearance, years of experience outside your range).

## What you need

- **Dossier** running on your computer (its README has a one-command Docker setup), with your profile filled in.
- **Node.js 22 or newer** (nodejs.org) and **git**.
- An **Anthropic API key** (console.anthropic.com).
- A **Gmail** inbox for applications. Greenhouse emails a security code before it accepts an application, and the applier reads it (read-only).

## Setup (once, about 20 minutes)

Prefer to be guided? Use [AI_SETUP_PROMPT.md](AI_SETUP_PROMPT.md) instead of the steps below.

1. **In Dossier:**
   - Settings → AI provider: set one up (Dossier writes each tailored resume).
   - Settings → Job search: choose **FreeHire** (it lists jobs straight from company Greenhouse and Lever pages).
   - Settings → MCP connector: turn on **Let apps connect**.
2. **Get the code:**
   ```
   git clone <this repo's address, from the green Code button>
   cd dossier_extension
   npm install
   npx playwright install chromium
   ```
   `npm install` also switches on the privacy check (see below).
3. **Your settings** (both files are git-ignored, so they never leave your computer):
   ```
   cp .env.example .env                                         # Windows: copy .env.example .env
   cp config/answer-bank.example.yaml config/answer-bank.yaml   # Windows: copy config\answer-bank.example.yaml config\answer-bank.yaml
   ```
   - `.env`: your Dossier password (the plain password you sign in with) and your Anthropic API key.
   - `config/answer-bank.yaml`: replace **every** value. The example is a made-up person (Alex Rivera). Read the comments: they explain each answer, the job filters and the daily cap.
   - `config/settings.yaml`: the job titles to search for, under `search.queries`.
4. **Gmail (read-only):** in Google Cloud Console, create a project → enable the **Gmail API** → OAuth consent screen (External, add your Gmail address as a **test user**) → Credentials → Create OAuth client → **Desktop app** → download the JSON and save it as `config/google-oauth-client.json`.
   With `gmail.enabled: false` in `config/settings.yaml`, Greenhouse applications stop at the security code and wait for you.
5. `npm run setup`. Your browser opens twice: approve Dossier's connector request, then Gmail's read-only access.

## First runs: check before trusting it

1. `npm run try -- https://job-boards.greenhouse.io/<company>/jobs/<id>`
   Fills one real form and **stops before submitting**. Look at the browser and the field list it prints.
2. `npm run dry-run`
   The full daily run without submitting. Read `data/reports/<today>.md` and the screenshots in `data/evidence/`.
3. `npm run run -- --limit 3`
   The real thing, three applications. Remove `--limit` once you trust it.

## Every day

| Command | What it does |
|---|---|
| `npm run run` | The daily run (up to `daily_cap` applications). |
| `npm run pending` | Answer the questions applications stopped on; answers are saved to `config/my-answers.yaml` and reused. |
| `npm run retry -- --all` | Finish every stopped or failed application from its Dossier draft. |
| `npm run sync` | Explain every Draft in Dossier, mark submitted ones Sent, queue drafts that were never submitted. |
| `npm run report` | Today's report: sent, waiting on you (and why), failed. |

To run it on a schedule: Windows Task Scheduler (program `cmd.exe`, arguments `/c cd /d C:\path\to\dossier_extension && npm run run`) or cron on macOS/Linux (`30 9 * * * cd /path/to/dossier_extension && npm run run >> data/cron.log 2>&1`). The computer has to be on and Dossier running.

## Files

| Path | What | In git? |
|---|---|---|
| `AI_SETUP_PROMPT.md` | A prompt that turns any AI assistant into a step-by-step setup guide. | yes |
| `config/answer-bank.example.yaml` | A made-up person's answers: the template for yours. | yes |
| `config/answer-bank.yaml` | Your answers. | **never** |
| `config/my-answers.yaml` | Answers you gave through `npm run pending`. | **never** |
| `config/settings.yaml` | Searches, model, browser, Gmail. | yes |
| `.env` | Dossier password, Anthropic key. | **never** |
| `config/google-oauth-client.json` | Your Google OAuth client. | **never** |
| `data/` | Sign-ins, history, reports, resumes, screenshots. | **never** |

## Troubleshooting

| What you see | What to do |
|---|---|
| `npm run setup` says the Dossier password is wrong | `.env` must hold the plain password you sign in with, not a hash from Dossier's data. Wrap it in single quotes if it has special characters. |
| Google says "Access blocked" or "app has not completed verification" | Add your Gmail address as a **Test user** on the OAuth consent screen in Google Cloud Console. |
| Gmail sign-in never finishes | Make sure `config/google-oauth-client.json` is a **Desktop app** client, then run `npm run setup` again. |
| "Couldn't find the application form" | The job may be closed or need a login. `npm run retry -- --all` later; the screenshot is in `data/evidence/`. |
| "Incorrect security code" or it waits for a code | Gmail must be connected (`npm run setup`) and Greenhouse's code emails must reach that inbox. |
| An application stays a Draft | `npm run pending` asks you the question it stopped on, once, and remembers your answer. |
| Drafts in Dossier you don't recognise | `npm run sync` explains each one and queues the ones never submitted. |
| An answer on a form is wrong | Fix it in `config/answer-bank.yaml`; check what was filled in `data/evidence/<job>/fields.txt`. |

## Privacy check (before every commit and push)

If you change the code and push it, your details can't come along by accident. `npm install` turns on two git hooks:

- **pre-commit**: stops a commit if a staged file, or your git author name/email, contains any of your details.
- **pre-push**: stops a push if any commit being pushed contains them, in its files, its author, committer or message.

"Your details" are read from your own `config/answer-bank.yaml` (names, email, phone, street, ZIP, city, profile links, current and past employers, school), so you never have to write them anywhere public. Add anything else to `config/private-terms.txt`, one per line (also git-ignored). The check also blocks API keys, tokens, private keys and the personal files listed above. Run it on the whole history any time with `npm run check-private`.

Commit under a name that isn't yours if you like: `git config user.name "your-handle"` and `git config user.email "<id>+<handle>@users.noreply.github.com"` (GitHub → Settings → Emails shows your no-reply address).

## Tests

```
npm test        # unit and form tests against saved Greenhouse and Lever pages
npm run smoke   # fills the saved pages end to end in a real browser
```

Tests always use the made-up example answer bank, so they pass the same on every machine.

## License

MIT
