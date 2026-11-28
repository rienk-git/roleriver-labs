import { describe, expect, it, vi } from "vitest";
import {
  GmailConnectionProvisioner,
  GmailRefreshCoordinator,
  type RefreshLock,
} from "./refresh.js";
import type { StoredGmailTokens } from "./token-store.js";

const scope = {
  tenantId: "tenant",
  connectionId: "connection",
  sourceId: "gmail",
};
function serializedLock(): RefreshLock {
  let last: Promise<unknown> = Promise.resolve();
  return {
    async run(_key, operation) {
      const result = last.then(operation, operation);
      last = result.catch(() => {});
      return { status: "completed", value: await result };
    },
  };
}
describe("Gmail refresh coordination", () => {
  it("serializes concurrent refresh and persists a rotated token once", async () => {
    let stored: StoredGmailTokens = {
      refreshToken: "old",
      accessToken: "expired",
      expiresAt: 1000,
    };
    const tokens = {
      get: vi.fn(async () => ({ ...stored })),
      put: vi.fn(
        async (
          _tenant: string,
          _connection: string,
          value: StoredGmailTokens,
        ) => {
          stored = value;
        },
      ),
    };
    const oauth = {
      revoke: vi.fn(async () => {}),
      refresh: vi.fn(async () => ({
        accessToken: "new-access",
        refreshToken: "rotated",
        expiresIn: 3600,
      })),
    };
    const coordinator = new GmailRefreshCoordinator(
      scope,
      tokens,
      oauth,
      serializedLock(),
      () => 100000,
    );
    expect(
      await Promise.all([
        coordinator.accessToken(scope),
        coordinator.accessToken(scope),
      ]),
    ).toEqual(["new-access", "new-access"]);
    expect(oauth.refresh).toHaveBeenCalledTimes(1);
    expect(tokens.put).toHaveBeenCalledTimes(1);
    expect(stored.refreshToken).toBe("rotated");
    await expect(
      coordinator.accessToken({ ...scope, tenantId: "other" }),
    ).rejects.toThrow();
  });
  it("does not return a refreshed token when the token gate denies its persistence", async () => {
    const tokens = {
      get: async () => ({ refreshToken: "old" }),
      put: vi.fn(async () => {
        throw new Error("disconnected");
      }),
    };
    const revoke = vi.fn(async () => {});
    const coordinator = new GmailRefreshCoordinator(
      scope,
      tokens,
      {
        revoke,
        refresh: async () => ({
          accessToken: "new",
          refreshToken: "rotated",
          expiresIn: 3600,
        }),
      },
      serializedLock(),
      () => 100000,
    );
    await expect(coordinator.accessToken(scope)).rejects.toThrow(
      "Gmail refresh failed",
    );
    expect(tokens.put).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("rotated");
  });
  it("fails closed when another refresher holds the shared lock", async () => {
    const coordinator = new GmailRefreshCoordinator(
      scope,
      { get: vi.fn(), put: vi.fn() },
      { refresh: vi.fn(), revoke: vi.fn() },
      { run: async () => ({ status: "busy" }) },
    );
    await expect(coordinator.accessToken(scope)).rejects.toThrow(
      "Gmail refresh failed",
    );
  });
  it("rejects a code exchange without a new refresh token rather than reusing an unverified mailbox", async () => {
    const tokens = {
      get: vi.fn(async () => null),
      put: vi.fn(),
    };
    const revoke = vi.fn(async () => {});
    const provisioner = new GmailConnectionProvisioner(
      scope,
      tokens,
      {
        complete: async () => ({ accessToken: "new-access", expiresIn: 3600 }),
        revoke,
      },
      serializedLock(),
      () => 100000,
    );
    await expect(provisioner.complete("synthetic")).rejects.toThrow(
      "Gmail connection failed",
    );
    expect(tokens.get).toHaveBeenCalledOnce();
    expect(tokens.put).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("new-access");
  });
  it("attempts to revoke newly issued refresh credentials when persistence fails", async () => {
    const revoke = vi.fn(async () => {});
    const provisioner = new GmailConnectionProvisioner(
      scope,
      {
        get: async () => null,
        put: async () => {
          throw new Error("private failure");
        },
      },
      {
        complete: async () => ({
          accessToken: "new-access",
          refreshToken: "new-refresh",
          expiresIn: 3600,
        }),
        revoke,
      },
      serializedLock(),
      () => 100000,
    );
    await expect(provisioner.complete("synthetic")).rejects.not.toThrow(
      "private failure",
    );
    expect(revoke).toHaveBeenCalledWith("new-refresh");
  });
  it("does not exchange credentials over an existing, unverified connection", async () => {
    const complete = vi.fn();
    const provisioner = new GmailConnectionProvisioner(
      scope,
      { get: async () => ({ refreshToken: "old" }), put: vi.fn() },
      { complete, revoke: vi.fn() },
      serializedLock(),
    );
    await expect(provisioner.complete("synthetic")).rejects.toThrow(
      "Gmail connection failed",
    );
    expect(complete).not.toHaveBeenCalled();
  });
  it("revokes rotated credentials when the post-issuance clock throws", async () => {
    const now = vi
      .fn()
      .mockReturnValueOnce(100000)
      .mockImplementationOnce(() => {
        throw new Error("private clock");
      });
    const revoke = vi.fn(async () => {});
    const coordinator = new GmailRefreshCoordinator(
      scope,
      { get: async () => ({ refreshToken: "old" }), put: vi.fn() },
      {
        refresh: async () => ({
          accessToken: "access",
          refreshToken: "rotated",
          expiresIn: 3600,
        }),
        revoke,
      },
      serializedLock(),
      now,
    );
    await expect(coordinator.accessToken(scope)).rejects.toThrow(
      "Gmail refresh failed",
    );
    expect(revoke).toHaveBeenCalledWith("rotated");
  });
  it("reports sanitized manual remediation when issued credentials cannot be revoked", async () => {
    const provisioner = new GmailConnectionProvisioner(
      scope,
      {
        get: async () => null,
        put: async () => {
          throw new Error("private persistence");
        },
      },
      {
        complete: async () => ({
          accessToken: "access",
          refreshToken: "secret",
          expiresIn: 3600,
        }),
        revoke: async () => {
          throw new Error("private provider");
        },
      },
      serializedLock(),
      () => 100000,
    );
    await expect(provisioner.complete("synthetic")).rejects.toMatchObject({
      code: "manual_remediation_required",
      message: "Gmail credentials require manual remediation",
    });
  });
  it("attempts revocation when the provisioning clock is invalid after exchange", async () => {
    const revoke = vi.fn(async () => {});
    const provisioner = new GmailConnectionProvisioner(
      scope,
      { get: async () => null, put: vi.fn() },
      {
        complete: async () => ({
          accessToken: "access",
          refreshToken: "new-refresh",
          expiresIn: 3600,
        }),
        revoke,
      },
      serializedLock(),
      () => NaN,
    );
    await expect(provisioner.complete("synthetic")).rejects.toThrow(
      "Gmail connection failed",
    );
    expect(revoke).toHaveBeenCalledWith("new-refresh");
  });
});
