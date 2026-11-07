import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { BrowserContext } from "playwright";

// Downloads PDFs from Dossier the way its own Download button does:
// GET /api/pdf?doc=…, with a signed-in session. The connector gives text only,
// so this is the one place the applier signs in to Dossier with its password.

export class DossierPdf {
  private signedIn = false;
  constructor(
    private readonly context: BrowserContext,
    private readonly baseUrl: string,
    private readonly password: string,
  ) {}

  private async signIn(): Promise<void> {
    if (this.signedIn) return;
    const page = await this.context.newPage();
    try {
      await page.goto(new URL("/login", this.baseUrl).toString());
      if (new URL(page.url()).pathname === "/login") {
        await page.locator('input[type="password"]').fill(this.password);
        await page.keyboard.press("Enter");
        await page.waitForURL((url) => url.pathname !== "/login", { timeout: 20_000 }).catch(() => {
          throw new Error("Couldn't sign in to Dossier: check DOSSIER_PASSWORD in .env.");
        });
      }
      this.signedIn = true;
    } finally {
      await page.close();
    }
  }

  /** Saves a PDF to `folder` as `fileName` and returns its path. */
  async download(query: { doc: "base" } | { doc: "resume" | "letter"; application: string }, folder: string, fileName: string): Promise<string> {
    await this.signIn();
    const url = new URL("/api/pdf", this.baseUrl);
    url.searchParams.set("doc", query.doc);
    if ("application" in query) url.searchParams.set("application", query.application);
    const response = await this.context.request.get(url.toString(), { timeout: 120_000 });
    if (!response.ok()) {
      const body = await response.text();
      throw new Error(`Dossier couldn't make the PDF (${response.status()}): ${body.slice(0, 200)}`);
    }
    const path = join(folder, fileName);
    writeFileSync(path, await response.body());
    return path;
  }
}
