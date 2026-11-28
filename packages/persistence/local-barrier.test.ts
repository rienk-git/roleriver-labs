import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { LocalTenantBarrier } from "./local-barrier.js";

const roots: string[] = [];
async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "roleriver-barrier-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("local tenant barrier", () => {
  it("excludes another process for the same tenant and releases on callback failure", async () => {
    const root = await createRoot();
    const barrier = await LocalTenantBarrier.open(root);
    await expect(
      barrier.run("tenant", async () => {
        expect(
          spawnSync("/usr/bin/flock", ["-n", join(root, "tenant"), "true"])
            .status,
        ).toBe(1);
        expect(await barrier.run("tenant", async () => "never")).toEqual({
          status: "busy",
        });
        expect(await barrier.run("other", async () => "done")).toEqual({
          status: "completed",
          value: "done",
        });
        throw new Error("synthetic");
      }),
    ).rejects.toThrow("synthetic");
    expect(await barrier.run("tenant", async () => "done")).toEqual({
      status: "completed",
      value: "done",
    });
  });

  it("releases the barrier when the owning process dies", async () => {
    const root = await createRoot();
    const moduleUrl = new URL("./local-barrier.ts", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { LocalTenantBarrier } from ${JSON.stringify(moduleUrl)}; const b=await LocalTenantBarrier.open(process.argv[1]); await b.run("tenant", async()=>{ process.stdout.write("held\\n"); await new Promise(()=>{ setInterval(()=>{},1000); }); });`,
        root,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr!.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        once(child.stdout!, "data"),
        once(child, "exit").then(() => {
          throw new Error("barrier child exited early");
        }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`barrier child timed out: ${stderr}`)),
            5000,
          );
        }),
      ]);
      const barrier = await LocalTenantBarrier.open(root);
      expect(await barrier.run("tenant", async () => "never")).toEqual({
        status: "busy",
      });
      child.kill("SIGKILL");
      await once(child, "exit");
      expect(await barrier.run("tenant", async () => "done")).toEqual({
        status: "completed",
        value: "done",
      });
    } finally {
      if (timer) clearTimeout(timer);
      child.kill("SIGKILL");
    }
  }, 10000);

  it("rejects a symlinked lock file without exposing its private path", async () => {
    const root = await createRoot();
    const barrier = await LocalTenantBarrier.open(root);
    await symlink(join(root, "synthetic-secret"), join(root, "tenant"));
    await expect(barrier.run("tenant", async () => undefined)).rejects.toThrow(
      "Local tenant barrier failed",
    );
    await expect(
      barrier.run("tenant", async () => undefined),
    ).rejects.not.toThrow(root);
  });
});
