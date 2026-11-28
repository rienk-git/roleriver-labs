import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export class GmailOAuthError extends Error {
  constructor(
    readonly code:
      | "invalid_callback"
      | "policy_denied"
      | "reconnect_required"
      | "provider_error",
  ) {
    super(`Gmail OAuth failed: ${code}`);
  }
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
}

export interface GoogleOAuthOptions {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  fetcher: typeof fetch;
  /** Must hold the same tenant barrier and check the connection until the request drains. */
  gate: { run<T>(operation: () => Promise<T>): Promise<T> };
  /** Durably mark issuance ambiguous before exposing an authorization URL or exchanging a code. */
  exchangeStarted(): Promise<void>;
  /** Must enforce the application's source policy before each request. */
  allow: (url: string) => boolean | Promise<boolean>;
  timeoutMs?: number;
}

/** Creates an offline, single-use authorization transaction; never opens a browser or listener. */
export function createGoogleOAuth(options: GoogleOAuthOptions) {
  let redirect: URL;
  try {
    redirect = new URL(options.redirectUri);
  } catch {
    throw new GmailOAuthError("invalid_callback");
  }
  if (
    !options.clientId ||
    redirect.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(redirect.hostname) ||
    !redirect.port ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash ||
    redirect.href !== options.redirectUri
  ) {
    throw new GmailOAuthError("invalid_callback");
  }
  const timeout = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000)
    throw new GmailOAuthError("provider_error");
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  let used = false;
  const expires = Date.now() + 10 * 60_000;

  async function request(
    endpoint: string,
    params: URLSearchParams,
  ): Promise<unknown> {
    try {
      return await options.gate.run(async () => {
        if (!(await options.allow(endpoint)))
          throw new GmailOAuthError("policy_denied");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        let text: string;
        let result: Response;
        try {
          result = await options.fetcher(endpoint, {
            method: "POST",
            body: params,
            redirect: "error",
            signal: controller.signal,
            headers: { "content-type": "application/x-www-form-urlencoded" },
          });
          const read = async () => {
            if (!result.body) return "";
            const reader = result.body.getReader();
            const chunks: Uint8Array[] = [];
            let size = 0;
            try {
              while (true) {
                const item = await reader.read();
                if (item.done) break;
                size += item.value.length;
                if (size > 65536) {
                  controller.abort();
                  throw new GmailOAuthError("provider_error");
                }
                chunks.push(item.value);
              }
              return Buffer.concat(chunks).toString("utf8");
            } catch (error) {
              controller.abort();
              await reader.cancel().catch(() => undefined);
              throw error;
            } finally {
              reader.releaseLock();
            }
          };
          text = await read();
        } finally {
          if (timer) clearTimeout(timer);
        }
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
        if (!result.ok) {
          if (
            endpoint === TOKEN_URL &&
            typeof body === "object" &&
            body !== null &&
            "error" in body &&
            body.error === "invalid_grant"
          )
            throw new GmailOAuthError("reconnect_required");
          throw new GmailOAuthError("provider_error");
        }
        return body;
      });
    } catch (error) {
      if (error instanceof GmailOAuthError) throw error;
      throw new GmailOAuthError("provider_error");
    }
  }
  const credentials = () => ({
    client_id: options.clientId,
    ...(options.clientSecret ? { client_secret: options.clientSecret } : {}),
  });
  function parseTokens(value: unknown): GoogleTokens {
    if (
      typeof value !== "object" ||
      value === null ||
      !("access_token" in value) ||
      typeof value.access_token !== "string" ||
      !value.access_token ||
      !("expires_in" in value) ||
      typeof value.expires_in !== "number" ||
      !Number.isFinite(value.expires_in) ||
      value.expires_in <= 0
    )
      throw new GmailOAuthError("provider_error");
    if (
      "refresh_token" in value &&
      (typeof value.refresh_token !== "string" || !value.refresh_token)
    )
      throw new GmailOAuthError("provider_error");
    return {
      accessToken: value.access_token,
      expiresIn: value.expires_in,
      ...("refresh_token" in value && typeof value.refresh_token === "string"
        ? { refreshToken: value.refresh_token }
        : {}),
    };
  }
  return {
    async authorizationUrl(): Promise<string> {
      try {
        await options.exchangeStarted();
      } catch {
        throw new GmailOAuthError("provider_error");
      }
      return url.href;
    },
    async complete(callbackUrl: string): Promise<GoogleTokens> {
      if (used || Date.now() > expires)
        throw new GmailOAuthError("invalid_callback");
      used = true;
      let callback: URL;
      try {
        callback = new URL(callbackUrl);
      } catch {
        throw new GmailOAuthError("invalid_callback");
      }
      const returnedState = callback.searchParams.getAll("state");
      const codes = callback.searchParams.getAll("code");
      if (
        callback.origin !== redirect.origin ||
        callback.pathname !== redirect.pathname ||
        callback.username ||
        callback.password ||
        callback.hash ||
        returnedState.length !== 1 ||
        codes.length !== 1 ||
        callback.searchParams.has("error") ||
        !codes[0] ||
        Buffer.byteLength(returnedState[0]!) !== Buffer.byteLength(state) ||
        !timingSafeEqual(Buffer.from(returnedState[0]!), Buffer.from(state))
      )
        throw new GmailOAuthError("invalid_callback");
      const body = new URLSearchParams({
        ...credentials(),
        code: codes[0],
        code_verifier: verifier,
        redirect_uri: options.redirectUri,
        grant_type: "authorization_code",
      });
      try {
        await options.exchangeStarted();
      } catch {
        throw new GmailOAuthError("provider_error");
      }
      return parseTokens(await request(TOKEN_URL, body));
    },
    async refresh(refreshToken: string): Promise<GoogleTokens> {
      if (!refreshToken) throw new GmailOAuthError("reconnect_required");
      try {
        await options.exchangeStarted();
      } catch {
        throw new GmailOAuthError("provider_error");
      }
      return parseTokens(
        await request(
          TOKEN_URL,
          new URLSearchParams({
            ...credentials(),
            refresh_token: refreshToken,
            grant_type: "refresh_token",
          }),
        ),
      );
    },
    async revoke(token: string): Promise<void> {
      if (!token) throw new GmailOAuthError("provider_error");
      await request(REVOKE_URL, new URLSearchParams({ token }));
    },
  };
}
