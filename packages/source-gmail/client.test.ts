import { describe, expect, it, vi } from "vitest";
import { createGmailClient } from "./client.js";

const scope = { tenantId: "t", connectionId: "c", sourceId: "gmail" };
const config = { version: "v1", query: "", labelIds: ["INBOX"] };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
function setup(responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>(async () => responses.shift()!);
  const authorize = vi.fn(async () => true);
  const token = vi.fn(async () => "synthetic-token");
  const client = createGmailClient({
    fetch: fetcher,
    authorize,
    accessToken: token,
  });
  return { client, fetcher, authorize, token };
}

describe("Gmail HTTP client", () => {
  it("checks policy and issues a fixed, redirect-disabled request", async () => {
    const { client, fetcher, authorize } = setup([json({ historyId: "123" })]);
    expect(await client.watermark(scope)).toBe("123");
    expect(authorize).toHaveBeenCalledWith(
      scope,
      "email",
      "gmail.googleapis.com",
    );
    expect(fetcher).toHaveBeenCalledWith(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      expect.objectContaining({ redirect: "error", method: "GET" }),
    );
  });
  it("does not obtain tokens or dispatch if policy denies", async () => {
    const fetcher = vi.fn();
    const token = vi.fn();
    const client = createGmailClient({
      fetch: fetcher,
      accessToken: token,
      authorize: async () => false,
    });
    await expect(client.watermark(scope)).rejects.toThrow();
    expect(token).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("encodes listing parameters and parses history changes", async () => {
    const { client, fetcher } = setup([
      json({ messages: [{ id: "a" }], nextPageToken: "next" }),
      json({
        historyId: "12",
        history: [
          {
            messagesAdded: [{ message: { id: "a" } }],
            labelsRemoved: [{ message: { id: "b" } }],
          },
        ],
      }),
    ]);
    expect(
      await client.list({
        scope,
        query: "from:a@example.test",
        labelIds: ["INBOX"],
        pageToken: "n+1",
      }),
    ).toEqual({ messageIds: ["a"], nextPageToken: "next" });
    const url = new URL(fetcher.mock.calls[0]![0] as unknown as string);
    expect(url.searchParams.get("q")).toBe("from:a@example.test");
    expect(url.searchParams.get("labelIds")).toBe("INBOX");
    expect(url.searchParams.get("pageToken")).toBe("n+1");
    expect(await client.history({ scope, startHistoryId: "10" })).toEqual({
      messageIds: ["a", "b"],
      nextPageToken: null,
      historyId: "12",
    });
  });
  it("returns unknown for arbitrary search queries without dispatch", async () => {
    const { client, fetcher } = setup([]);
    expect(
      await client.reconcile(scope, "a", { ...config, query: "is:unread" }),
    ).toEqual({ kind: "unknown", messageId: "a" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("reconciles only verified labels and inline plain text", async () => {
    const { client, fetcher } = setup([
      json({
        id: "a",
        historyId: "11",
        labelIds: ["INBOX"],
        payload: { mimeType: "text/plain", filename: "" },
      }),
      json({
        id: "a",
        historyId: "11",
        labelIds: ["INBOX"],
        payload: {
          mimeType: "text/plain",
          filename: "",
          body: { data: "aGVsbG8" },
        },
      }),
      json({ id: "a", historyId: "12", labelIds: [], payload: {} }),
    ]);
    expect(await client.reconcile(scope, "a", config)).toEqual({
      kind: "eligible",
      messageId: "a",
      revision: "11",
      text: "hello",
    });
    const requested = new URL(fetcher.mock.calls[0]![0] as string);
    expect(requested.searchParams.get("fields")).toBe(
      "id,historyId,labelIds,payload(mimeType,filename)",
    );
    expect(requested.searchParams.get("format")).toBe("full");
    expect(
      new URL(fetcher.mock.calls[1]![0] as string).searchParams.get("format"),
    ).toBe("full");
    expect(await client.reconcile(scope, "a", config)).toEqual({
      kind: "excluded",
      messageId: "a",
      revision: "12",
    });
  });
  it("rejects malformed responses and sanitizes provider errors", async () => {
    const { client } = setup([
      json({ historyId: "private" }),
      new Response("secret body", { status: 500 }),
    ]);
    await expect(client.watermark(scope)).rejects.toThrow(
      "Gmail request failed",
    );
    await expect(client.watermark(scope)).rejects.toThrow(
      "Gmail request failed",
    );
  });
  it("fails closed for oversized responses and history expiration", async () => {
    const { client } = setup([
      new Response("x".repeat(2 * 1024 * 1024 + 1)),
      new Response("private", { status: 404 }),
    ]);
    await expect(client.watermark(scope)).rejects.toThrow(
      "Gmail request failed",
    );
    await expect(
      client.history({ scope, startHistoryId: "10" }),
    ).rejects.toMatchObject({ kind: "history_expired" });
  });
  it("does not classify messages in spam or trash as matches", async () => {
    const { client } = setup([
      json({
        id: "a",
        historyId: "13",
        labelIds: ["INBOX", "SPAM"],
        payload: { mimeType: "text/plain", body: { data: "aGVsbG8" } },
      }),
    ]);
    expect(await client.reconcile(scope, "a", config)).toEqual({
      kind: "excluded",
      messageId: "a",
      revision: "13",
    });
  });
  it("does not fetch a body for attachments or excluded labels", async () => {
    const { client, fetcher } = setup([
      json({
        id: "a",
        historyId: "1",
        labelIds: ["INBOX"],
        payload: { mimeType: "text/plain", filename: "attachment.txt" },
      }),
    ]);
    expect(await client.reconcile(scope, "a", config)).toEqual({
      kind: "unknown",
      messageId: "a",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    {
      historyId: "2",
      labelIds: ["INBOX"],
      payload: {
        mimeType: "text/plain",
        filename: "",
        body: { data: "aGVsbG8" },
      },
    },
    {
      historyId: "1",
      labelIds: ["TRASH"],
      payload: {
        mimeType: "text/plain",
        filename: "",
        body: { data: "aGVsbG8" },
      },
    },
    {
      historyId: "1",
      labelIds: ["INBOX"],
      payload: {
        mimeType: "text/plain",
        filename: "attachment.txt",
        body: { data: "aGVsbG8" },
      },
    },
  ])("fails closed if the message changes between requests", async (change) => {
    const { client } = setup([
      json({
        id: "a",
        historyId: "1",
        labelIds: ["INBOX"],
        payload: { mimeType: "text/plain", filename: "" },
      }),
      json({ id: "a", ...change }),
    ]);
    expect(await client.reconcile(scope, "a", config)).toEqual({
      kind: "unknown",
      messageId: "a",
    });
  });
  it("rechecks policy before fetching the body", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      json({
        id: "a",
        historyId: "1",
        labelIds: ["INBOX"],
        payload: { mimeType: "text/plain", filename: "" },
      }),
    );
    const authorize = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const client = createGmailClient({
      fetch: fetcher,
      authorize,
      accessToken: async () => "synthetic-token",
    });
    expect(await client.reconcile(scope, "a", config)).toEqual({
      kind: "unknown",
      messageId: "a",
    });
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
