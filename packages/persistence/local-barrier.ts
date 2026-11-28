import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";

const fail = () => new Error("Local tenant barrier failed");

/**
 * Linux local-filesystem advisory barrier. Use a separate root dedicated to
 * permanent lock files, shared by every cooperating process. The private root and all
 * ancestors must be trusted and non-replaceable; hostile same-UID processes are
 * outside this adapter's threat model. Lock files must never be moved or deleted.
 * Every tenant writer and collector must participate, including other processes.
 * The callback must await all I/O it starts and must not launch detached work.
 * This is not a distributed or S3 lock. Do not use on shared/network filesystems.
 */
export class LocalTenantBarrier {
  private readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async open(root: string): Promise<LocalTenantBarrier> {
    try {
      if (
        process.platform !== "linux" ||
        typeof process.getuid !== "function" ||
        !constants.O_NOFOLLOW
      )
        throw fail();
      const path = resolve(root);
      const stats = await lstat(path);
      if (
        (await realpath(path)) !== path ||
        !stats.isDirectory() ||
        stats.uid !== process.getuid() ||
        (stats.mode & 0o077) !== 0
      )
        throw fail();
      return new LocalTenantBarrier(path);
    } catch {
      throw fail();
    }
  }

  async run<T>(
    tenant: string,
    operation: () => Promise<T>,
  ): Promise<{ status: "busy" } | { status: "completed"; value: T }> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tenant)) throw fail();
    let file: FileHandle | undefined;
    try {
      let acquired: boolean;
      try {
        const root = await lstat(this.root);
        if (
          (await realpath(this.root)) !== this.root ||
          !root.isDirectory() ||
          root.uid !== process.getuid!() ||
          (root.mode & 0o077) !== 0
        )
          throw fail();
        file = await open(
          join(this.root, tenant),
          constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
          0o600,
        );
        const stats = await file.stat();
        if (
          !stats.isFile() ||
          stats.uid !== process.getuid!() ||
          (stats.mode & 0o077) !== 0 ||
          stats.nlink !== 1
        )
          throw fail();
        // flock acts on the open file description shared with the parent. The
        // parent's descriptor retains the lock after the helper exits.
        const lockFd = file.fd;
        acquired = await new Promise<boolean>((resolveResult, reject) => {
          const child = spawn("/usr/bin/flock", ["-n", "3"], {
            stdio: ["ignore", "ignore", "ignore", lockFd],
          });
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, 5000);
          child.once("error", () => {
            clearTimeout(timer);
            reject(fail());
          });
          child.once("close", (code) => {
            clearTimeout(timer);
            if (timedOut || (code !== 0 && code !== 1)) reject(fail());
            else resolveResult(code === 0);
          });
        });
      } catch {
        throw fail();
      }
      if (!acquired) return { status: "busy" };
      return { status: "completed", value: await operation() };
    } finally {
      await file?.close();
    }
  }
}
