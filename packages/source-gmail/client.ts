import {
  GmailBoundaryError,
  type GmailClient,
  type PollScope,
  type ReconciledMessage,
} from "./poll.js";
import { GmailCredentialRemediationRequired } from "./refresh.js";

const origin = "https://gmail.googleapis.com/gmail/v1/users/me";
const validId = (x: unknown): x is string =>
  typeof x === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(x);
const validHistory = (x: unknown): x is string =>
  typeof x === "string" && /^\d{1,32}$/.test(x);
const record = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x);
const fail = (): never => {
  throw new Error("Gmail request failed");
};
const nextToken = (x: unknown): string | null =>
  x === undefined
    ? null
    : typeof x === "string" && x.length > 0 && x.length <= 2048
      ? x
      : fail();

// A field mask selects every element of a parts array, so multipart content is
// rejected: a later response could otherwise include an attachment's data.
const partFields = (withData: boolean): string => {
  const fields = "mimeType,filename,headers(name,value),body(attachmentId)";
  return withData
    ? fields.replace("body(attachmentId)", "body(data,attachmentId)")
    : fields;
};
function plainPart(payload: unknown): Record<string, unknown> | null {
  const part = payload;
  if (!record(part) || (part.filename !== undefined && part.filename !== ""))
    return null;
  if (
    part.body !== undefined &&
    (!record(part.body) || part.body.attachmentId !== undefined)
  )
    return null;
  if (part.headers !== undefined) {
    if (!Array.isArray(part.headers) || part.headers.length > 100) return null;
    let disposition = false;
    let contentType = false;
    for (const header of part.headers as unknown[]) {
      if (
        !record(header) ||
        typeof header.name !== "string" ||
        typeof header.value !== "string" ||
        header.name.length > 256 ||
        header.value.length > 8192
      )
        return null;
      if (header.name.toLowerCase() === "content-disposition") {
        if (disposition || header.value.trim().toLowerCase() !== "inline")
          return null;
        disposition = true;
      }
      if (header.name.toLowerCase() === "content-type") {
        if (
          contentType ||
          !/^text\/plain(?:\s*;\s*charset\s*=\s*(?:utf-8|us-ascii|"utf-8"|"us-ascii"))?\s*$/i.test(
            header.value,
          )
        )
          return null;
        contentType = true;
      }
    }
  }
  if (part.mimeType === "text/plain") {
    if (
      part.parts !== undefined &&
      (!Array.isArray(part.parts) || part.parts.length !== 0)
    )
      return null;
    return part;
  }
  return null;
}

export interface GmailHttpDependencies {
  fetch: typeof fetch;
  /** Must hold the tenant barrier and check connection state for the entire dispatch. */
  gate: { run<T>(scope: PollScope, operation: () => Promise<T>): Promise<T> };
  /** Must gate refresh and token reads/writes independently with the same tenant barrier. */
  accessToken(scope: PollScope): Promise<string>;
  /** Permission preflight only; must not consume a dispatch rate permit. */
  check(
    scope: PollScope,
    method: "email",
    host: "gmail.googleapis.com",
  ): Promise<boolean>;
  authorize(
    scope: PollScope,
    method: "email",
    host: "gmail.googleapis.com",
  ): Promise<boolean>;
}

/** The caller supplies tenant-bound credentials and a default-deny policy gate. */
export function createGmailClient(deps: GmailHttpDependencies): GmailClient {
  async function request(
    scope: PollScope,
    path: string,
    params?: URLSearchParams,
  ): Promise<Record<string, unknown>> {
    scope = Object.freeze({ ...scope });
    const url = origin + path + (params && params.size ? `?${params}` : "");
    try {
      // Credential acquisition must itself use the connection gate. It occurs
      // outside the request gate so refresh and token-store access never nest
      // the non-reentrant tenant barrier.
      if ((await deps.check(scope, "email", "gmail.googleapis.com")) !== true)
        return fail();
      const token = await deps.accessToken(scope);
      if (typeof token !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(token))
        return fail();
      return await deps.gate.run(scope, async () => {
        if (
          (await deps.authorize(scope, "email", "gmail.googleapis.com")) !==
          true
        )
          return fail();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        try {
          const response = await deps.fetch(url, {
            method: "GET",
            headers: { Authorization: `Bearer ${token}` },
            redirect: "error",
            signal: controller.signal,
          });
          if (!response.ok) {
            controller.abort();
            if (response.body)
              await response.body.cancel().catch(() => undefined);
            if (response.status === 401)
              throw new GmailBoundaryError("revoked");
            if (response.status === 404 && path === "/history")
              throw new GmailBoundaryError("history_expired");
            return fail();
          }
          if (!response.body) return fail();
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            while (true) {
              const part = await reader.read();
              if (part.done) break;
              size += part.value.byteLength;
              if (size > 2 * 1024 * 1024)
                throw new Error("Gmail response too large");
              chunks.push(part.value);
            }
          } catch (error) {
            controller.abort();
            await reader.cancel().catch(() => undefined);
            throw error;
          } finally {
            reader.releaseLock();
          }
          const decoded: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            ),
          );
          if (!record(decoded)) return fail();
          return decoded;
        } finally {
          clearTimeout(timer);
        }
      });
    } catch (error) {
      if (error instanceof GmailCredentialRemediationRequired) throw error;
      if (error instanceof GmailBoundaryError) throw error;
      return fail();
    }
  }
  return {
    async watermark(scope) {
      const data = await request(scope, "/profile");
      return validHistory(data.historyId) ? data.historyId : fail();
    },
    async list({ scope, query, labelIds, pageToken }) {
      if (
        typeof query !== "string" ||
        query.length > 4096 ||
        !Array.isArray(labelIds) ||
        !labelIds.every(validId) ||
        labelIds.length > 100 ||
        (pageToken !== undefined && nextToken(pageToken) === null)
      )
        return fail();
      const params = new URLSearchParams({ maxResults: "100" });
      if (query) params.set("q", query);
      for (const label of labelIds) params.append("labelIds", label);
      if (pageToken) params.set("pageToken", pageToken);
      const data = await request(scope, "/messages", params);
      if (data.messages !== undefined && !Array.isArray(data.messages))
        return fail();
      const ids = (data.messages ?? []) as unknown[];
      if (!ids.every((m) => record(m) && validId(m.id))) return fail();
      return {
        messageIds: ids.map((m) => (m as { id: string }).id),
        nextPageToken: nextToken(data.nextPageToken),
      };
    },
    async history({ scope, startHistoryId, pageToken }) {
      if (
        !validHistory(startHistoryId) ||
        (pageToken !== undefined && nextToken(pageToken) === null)
      )
        return fail();
      const params = new URLSearchParams({ startHistoryId, maxResults: "100" });
      if (pageToken) params.set("pageToken", pageToken);
      const data = await request(scope, "/history", params);
      if (
        !validHistory(data.historyId) ||
        (data.history !== undefined && !Array.isArray(data.history))
      )
        return fail();
      const ids = new Set<string>();
      for (const entry of (data.history ?? []) as unknown[]) {
        if (!record(entry)) return fail();
        if (entry.messages !== undefined) {
          if (!Array.isArray(entry.messages)) return fail();
          for (const message of entry.messages as unknown[]) {
            if (!record(message) || !validId(message.id)) return fail();
            ids.add(message.id);
          }
        }
        for (const field of [
          "messagesAdded",
          "messagesDeleted",
          "labelsAdded",
          "labelsRemoved",
        ] as const) {
          const changes = entry[field];
          if (changes === undefined) continue;
          if (!Array.isArray(changes)) return fail();
          for (const change of changes as unknown[]) {
            if (
              !record(change) ||
              !record(change.message) ||
              !validId(change.message.id)
            )
              return fail();
            ids.add(change.message.id);
          }
        }
      }
      return {
        messageIds: [...ids],
        nextPageToken: nextToken(data.nextPageToken),
        historyId: data.historyId,
      };
    },
    async reconcile(scope, messageId, config): Promise<ReconciledMessage> {
      if (
        !validId(messageId) ||
        typeof config.query !== "string" ||
        !Array.isArray(config.labelIds) ||
        !config.labelIds.every(validId)
      )
        return fail();
      const unknown = (): ReconciledMessage => ({ kind: "unknown", messageId });
      // Gmail's query language cannot be evaluated reliably from message metadata.
      if (config.query.trim()) return unknown();
      let data: Record<string, unknown>;
      try {
        data = await request(
          scope,
          `/messages/${messageId}`,
          new URLSearchParams({
            format: "full",
            fields: `id,historyId,labelIds,payload(${partFields(false)})`,
          }),
        );
      } catch (error) {
        if (error instanceof GmailCredentialRemediationRequired) throw error;
        if (error instanceof GmailBoundaryError) throw error;
        return unknown();
      }
      if (
        data.id !== messageId ||
        !validHistory(data.historyId) ||
        !Array.isArray(data.labelIds) ||
        !data.labelIds.every(validId)
      )
        return unknown();
      if (
        (data.labelIds as string[]).some(
          (label) => label === "SPAM" || label === "TRASH",
        ) ||
        !config.labelIds.every((label) =>
          (data.labelIds as string[]).includes(label),
        )
      )
        return { kind: "excluded", messageId, revision: data.historyId };
      const metadataPart = plainPart(data.payload);
      if (!metadataPart) return unknown();
      const revision = data.historyId;
      const labels = data.labelIds as string[];
      let body: Record<string, unknown>;
      try {
        body = await request(
          scope,
          `/messages/${messageId}`,
          new URLSearchParams({
            format: "full",
            fields: `id,historyId,labelIds,payload(${partFields(true)})`,
          }),
        );
      } catch (error) {
        if (error instanceof GmailCredentialRemediationRequired) throw error;
        if (error instanceof GmailBoundaryError) throw error;
        return unknown();
      }
      if (
        body.id !== messageId ||
        body.historyId !== revision ||
        !Array.isArray(body.labelIds) ||
        !body.labelIds.every(validId) ||
        body.labelIds.length !== labels.length ||
        !labels.every((label) => (body.labelIds as string[]).includes(label))
      )
        return unknown();
      const bodyPart = plainPart(body.payload);
      if (
        !bodyPart ||
        !record(bodyPart.body) ||
        typeof bodyPart.body.data !== "string" ||
        !/^[A-Za-z0-9_-]*={0,2}$/.test(bodyPart.body.data)
      )
        return unknown();
      try {
        const encoded = bodyPart.body.data.replace(/=+$/, "");
        const bytes = Buffer.from(encoded, "base64url");
        if (bytes.toString("base64url") !== encoded) return unknown();
        const headers = Array.isArray(bodyPart.headers) ? bodyPart.headers : [];
        const contentType = headers.find(
          (header: unknown) =>
            record(header) &&
            typeof header.name === "string" &&
            header.name.toLowerCase() === "content-type",
        );
        if (
          record(contentType) &&
          typeof contentType.value === "string" &&
          /charset\s*=\s*"?us-ascii"?\s*$/i.test(contentType.value) &&
          bytes.some((byte) => byte > 0x7f)
        )
          return unknown();
        // In the absence of a declared charset, accept only valid UTF-8.
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (text.length > 1024 * 1024) return unknown();
        return { kind: "eligible", messageId, revision, text };
      } catch {
        return unknown();
      }
    },
  };
}
