import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

import { dataDir } from "../config.js";

// Talks to Dossier's MCP connector (Settings → MCP connector → Let apps connect).
// Dossier accepts a loopback callback (http://localhost:<port>/callback) from any
// local app, so nothing has to be registered by hand. The first sign-in opens
// Dossier's consent page in your browser; tokens are kept in data/dossier-auth.json.

const CALLBACK_PORT = 53682;
const REDIRECT = `http://localhost:${CALLBACK_PORT}/callback`;

type Stored = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string };

class FileAuthProvider implements OAuthClientProvider {
  private readonly file = join(dataDir(), "dossier-auth.json");
  constructor(private readonly openUrl: (url: string) => void) {}

  private read(): Stored {
    return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Stored) : {};
  }
  private write(patch: Stored): void {
    writeFileSync(this.file, JSON.stringify({ ...this.read(), ...patch }, null, 2), { mode: 0o600 });
  }

  get redirectUrl() {
    return REDIRECT;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Job applier (local)",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  clientInformation() {
    return this.read().client;
  }
  saveClientInformation(client: OAuthClientInformationMixed) {
    this.write({ client });
  }
  tokens() {
    return this.read().tokens;
  }
  saveTokens(tokens: OAuthTokens) {
    this.write({ tokens });
  }
  redirectToAuthorization(url: URL) {
    this.openUrl(url.toString());
  }
  saveCodeVerifier(verifier: string) {
    this.write({ verifier });
  }
  codeVerifier() {
    const verifier = this.read().verifier;
    if (!verifier) throw new Error("No sign-in in progress.");
    return verifier;
  }
}

/** Waits for Dossier to send the browser back with ?code=… */
function waitForCode(): Promise<string> {
  return new Promise((resolveCode, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT);
      if (url.pathname !== "/callback") return void res.writeHead(404).end();
      const code = url.searchParams.get("code");
      res.writeHead(200, { "content-type": "text/plain" }).end(code ? "Signed in to Dossier. You can close this tab." : "Sign-in failed.");
      server.close();
      code ? resolveCode(code) : reject(new Error(url.searchParams.get("error") ?? "No code from Dossier."));
    });
    const keepAlive = setInterval(() => undefined, 1_000);
    server.on("close", () => clearInterval(keepAlive));
    server.on("error", (error) => {
      clearInterval(keepAlive);
      reject(new Error(`Couldn't listen for Dossier's reply on port ${CALLBACK_PORT}: ${error.message}`));
    });
    server.listen(CALLBACK_PORT, "127.0.0.1");
    setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for the Dossier sign-in."));
    }, 5 * 60_000).unref();
  });
}

export class Dossier {
  private constructor(private readonly client: Client) {}

  /** Connects, signing in through the browser the first time. */
  static async connect(baseUrl: string, openUrl: (url: string) => void): Promise<Dossier> {
    const endpoint = new URL("/api/mcp", baseUrl);
    const auth = new FileAuthProvider(openUrl);
    const attempt = async () => {
      const transport = new StreamableHTTPClientTransport(endpoint, { authProvider: auth });
      const client = new Client({ name: "job-applier", version: "0.1.0" });
      await client.connect(transport);
      return { client, transport };
    };
    try {
      return new Dossier((await attempt()).client);
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) {
        throw new Error(`Couldn't reach Dossier at ${endpoint}. Is it running, and is Settings → MCP connector → Let apps connect on? (${String(error)})`);
      }
      const code = waitForCode();
      const transport = new StreamableHTTPClientTransport(endpoint, { authProvider: auth });
      // The first attempt already opened the consent page; finish with the code it sends back.
      await transport.finishAuth(await code);
      return new Dossier((await attempt()).client);
    }
  }

  /** Calls a tool and returns its JSON answer, or throws Dossier's message. */
  async call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.client.callTool({ name, arguments: args });
    const content = (result.content as { type: string; text?: string }[] | undefined) ?? [];
    const body = content.map((part) => part.text ?? "").join("\n");
    if (result.isError) throw new Error(`Dossier ${name}: ${body}`);
    try {
      return JSON.parse(body) as T;
    } catch {
      return body as T;
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

// ---- The shapes of the tool answers this project uses (from Dossier's src/lib/connector/tools.ts) ----

export type SearchResult = {
  search_id: string;
  found: number;
  more_available: boolean;
  postings: {
    number: number;
    title: string;
    company: string;
    place: string;
    remote: boolean | null;
    salary?: string;
    posted?: string;
    via?: string;
    url?: string;
    applied?: boolean;
    fit?: number;
    snippet: string;
  }[];
};

export type PostingText = { url?: string; title: string; company: string; place: string; text: string };
export type DraftStarted = { draft_id: string; status: "started" };
export type DraftState = { draft_id: string; status: "working" | "done"; application_id?: string; link?: string; step?: string };
