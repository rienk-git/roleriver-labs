import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createLocalClient, VacancyRepository } from "./dynamodb.js";

describe("local persistence boundaries", () => {
  it.each([
    "https://example.com:8000",
    "http://example.com:8000",
    "http://localhost",
    "http://127.0.0.1:8000/path",
    "http://user:pass@localhost:8000",
  ])("rejects non-local or ambiguous endpoint %s", (endpoint) => {
    expect(() => createLocalClient(endpoint)).toThrow();
  });
  it.each([
    "http://example.test/job",
    "https://user:pass@example.test/job",
    "https://example.test/job?token=secret",
    "https://example.test/job#secret",
    "https://example.test/jo\nb",
    String.raw`https:\\@example.test/job`,
    "https:/@example.test/job",
    String.raw`https://example.test/a\b`,
    "https://example.test/jo\tb",
    "https://example.test/jo\u007fb",
    "https://example.test/jo\u00a0b",
    "not a url",
  ])("rejects unsafe source URLs before any request", async (sourceUrl) => {
    const send = vi.fn();
    const repo = new VacancyRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "test_table",
      "cursor-secret-at-least-32-bytes-long",
    );
    await expect(
      repo.create("tenant-a", {
        id: "id",
        title: "Role",
        organization: "Example",
        createdAt: "2026-01-01T00:00:00.000Z",
        source: "feed",
        externalId: "1",
        sourceUrl,
      }),
    ).rejects.toThrow();
    await expect(
      repo.attachSource("tenant-a", "id", "feed", "1", { url: sourceUrl }),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it("does not expose rejected URL secrets in validation errors", async () => {
    const send = vi.fn();
    const repo = new VacancyRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "test_table",
      "cursor-secret-at-least-32-bytes-long",
    );
    try {
      await repo.attachSource("tenant-a", "id", "feed", "one", {
        url: "https://user:secret@example.test/job?token=secret",
      });
      throw new Error("Expected validation failure");
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
    expect(send).not.toHaveBeenCalled();
  });
  it("fails closed on invalid cursor before any request", async () => {
    const send = vi.fn();
    const client = { send } as unknown as DynamoDBDocumentClient;
    const repo = new VacancyRepository(
      client,
      "test_table",
      "cursor-secret-at-least-32-bytes-long",
    );
    await expect(
      repo.listRecent("tenant-a", { limit: 1, cursor: "forged.value" }),
    ).rejects.toThrow("Invalid cursor");
    expect(send).not.toHaveBeenCalled();
  });
  it("does not misclassify a mixed transaction cancellation as an identity conflict", async () => {
    const failure = Object.assign(new Error("private payload"), {
      name: "TransactionCanceledException",
      CancellationReasons: [
        { Code: "ConditionalCheckFailed" },
        { Code: "TransactionConflict" },
      ],
    });
    const send = vi.fn().mockRejectedValue(failure);
    const repo = new VacancyRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "test_table",
      "cursor-secret-at-least-32-bytes-long",
    );
    await expect(
      repo.create("tenant-a", {
        id: "id",
        title: "Role",
        organization: "Example",
        createdAt: "2026-01-01T00:00:00.000Z",
        source: "feed",
        externalId: "1",
      }),
    ).rejects.toThrow("Persistence operation failed");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("uses bounded retries and an abortable request and redacts write errors", async () => {
    const send = vi.fn().mockRejectedValue(new Error("secret payload"));
    const repo = new VacancyRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "test_table",
      "cursor-secret-at-least-32-bytes-long",
    );
    await expect(
      repo.create("tenant-a", {
        id: "id",
        title: "Role",
        organization: "Example",
        createdAt: "2026-01-01T00:00:00.000Z",
        source: "feed",
        externalId: "1",
      }),
    ).rejects.toThrow("Persistence operation failed");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1]?.abortSignal).toBeInstanceOf(AbortSignal);
  });
});
