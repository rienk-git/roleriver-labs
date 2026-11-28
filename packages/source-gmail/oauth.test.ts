import { describe, expect, it, vi } from "vitest";
import { createGoogleOAuth, GmailOAuthError } from "./oauth.js";

const gate = { run: async <T>(operation: () => Promise<T>) => operation() };
const redirectUri = "http://127.0.0.1:43210/callback";
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("desktop Google OAuth", () => {
  it("does not expose consent URL or exchange a code if issuance marking fails", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const oauth = createGoogleOAuth({
      clientId: "client",
      redirectUri,
      fetcher,
      gate,
      allow: () => true,
      exchangeStarted: async () => {
        throw new Error("private failure");
      },
    });
    await expect(oauth.authorizationUrl()).rejects.toMatchObject({
      code: "provider_error",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("creates PKCE and state and exchanges a verified loopback callback", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      response({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
      }),
    );
    const allow = vi.fn(() => true);
    const oauth = createGoogleOAuth({
      clientId: "client",
      exchangeStarted: async () => {},
      gate,
      redirectUri,
      fetcher,
      allow,
    });
    const url = new URL(await oauth.authorizationUrl());
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/gmail.readonly",
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    const state = url.searchParams.get("state");
    expect(state).toBeTruthy();
    const tokens = await oauth.complete(
      `${redirectUri}?code=synthetic&state=${state}`,
    );
    expect(tokens.refreshToken).toBe("refresh");
    expect(allow).toHaveBeenCalledWith("https://oauth2.googleapis.com/token");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      method: "POST",
    });
    await expect(
      oauth.complete(`${redirectUri}?code=synthetic&state=${state}`),
    ).rejects.toBeInstanceOf(GmailOAuthError);
  });

  it("rejects invalid redirects, state, and denied policy without dispatch", async () => {
    const fetcher = vi.fn(async () => response({}));
    expect(() =>
      createGoogleOAuth({
        clientId: "client",
        exchangeStarted: async () => {},
        gate,
        redirectUri: "http://localhost:43210/callback",
        fetcher,
        allow: () => true,
      }),
    ).toThrow();
    const oauth = createGoogleOAuth({
      clientId: "client",
      exchangeStarted: async () => {},
      gate,
      redirectUri,
      fetcher,
      allow: () => true,
    });
    await expect(
      oauth.complete(`${redirectUri}?code=synthetic&state=wrong`),
    ).rejects.toBeInstanceOf(GmailOAuthError);
    expect(fetcher).not.toHaveBeenCalled();
    const denied = createGoogleOAuth({
      clientId: "client",
      exchangeStarted: async () => {},
      gate,
      redirectUri,
      fetcher,
      allow: () => false,
    });
    const state = new URL(await denied.authorizationUrl()).searchParams.get(
      "state",
    );
    await expect(
      denied.complete(`${redirectUri}?code=synthetic&state=${state}`),
    ).rejects.toBeInstanceOf(GmailOAuthError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refreshes and revokes via fixed endpoints and sanitizes provider errors", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      response({ error: "invalid_grant", secret: "do-not-report" }, 400),
    );
    const oauth = createGoogleOAuth({
      clientId: "client",
      exchangeStarted: async () => {},
      gate,
      redirectUri,
      fetcher,
      allow: () => true,
    });
    await expect(oauth.refresh("synthetic-refresh")).rejects.toMatchObject({
      code: "reconnect_required",
    });
    await expect(oauth.revoke("synthetic-refresh")).rejects.toMatchObject({
      code: "provider_error",
    });
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "https://oauth2.googleapis.com/revoke",
    );
  });
  it("rejects an incorrect callback and bounds an unresponsive transport", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    const oauth = createGoogleOAuth({
      clientId: "client",
      exchangeStarted: async () => {},
      gate,
      redirectUri,
      fetcher,
      allow: () => true,
      timeoutMs: 10,
    });
    const state = new URL(await oauth.authorizationUrl()).searchParams.get(
      "state",
    );
    await expect(
      oauth.complete(`http://127.0.0.1:43211/callback?code=x&state=${state}`),
    ).rejects.toMatchObject({ code: "invalid_callback" });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(oauth.refresh("synthetic")).rejects.toMatchObject({
      code: "provider_error",
    });
  });
});
