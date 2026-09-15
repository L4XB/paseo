import { mkdir, mkdtemp, open, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  acquirePidLock,
  getPidLockInfo,
  isLocked,
  isSameFileEntry,
  PidLockError,
  refreshPidLock,
  releasePidLock,
  updatePidLock,
} from "./pid-lock.js";

describe("pid-lock ownership", () => {
  test("writes and releases lock for explicit owner pid", async () => {
    const parent = await mkdtemp(join(tmpdir(), "paseo-pid-lock-owner-"));
    const paseoHome = join(parent, "home");
    const ownerPid = process.pid + 10_000;

    try {
      await (
        acquirePidLock as unknown as (
          home: string,
          sockPath: string | null,
          options: { ownerPid: number },
        ) => Promise<void>
      )(paseoHome, null, { ownerPid });

      if (process.platform !== "win32") {
        expect((await stat(paseoHome)).mode & 0o777).toBe(0o700);
      }
      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(ownerPid);
      expect(lock?.listen).toBeNull();
      expect(lock?.heartbeat).toBe(true);

      await (
        updatePidLock as unknown as (
          home: string,
          patch: { listen: string },
          options: { ownerPid: number },
        ) => Promise<void>
      )(paseoHome, { listen: "127.0.0.1:6767" }, { ownerPid });

      const updatedLock = await getPidLockInfo(paseoHome);
      expect(updatedLock?.listen).toBe("127.0.0.1:6767");

      await (
        releasePidLock as unknown as (home: string, options: { ownerPid: number }) => Promise<void>
      )(paseoHome, { ownerPid: ownerPid + 1 });
      const lockAfterWrongOwnerRelease = await getPidLockInfo(paseoHome);
      expect(lockAfterWrongOwnerRelease?.pid).toBe(ownerPid);

      await (
        releasePidLock as unknown as (home: string, options: { ownerPid: number }) => Promise<void>
      )(paseoHome, { ownerPid });
      const lockAfterOwnerRelease = await getPidLockInfo(paseoHome);
      expect(lockAfterOwnerRelease).toBeNull();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("keeps a stale heartbeat lock when the recorded pid is alive without a reachability check", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-stale-heartbeat-"));
    const replacementOwnerPid = process.pid + 10_000;

    try {
      const pidPath = join(paseoHome, "paseo.pid");
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00.000Z",
          hostname: "old-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
          heartbeat: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(isLocked(paseoHome)).resolves.toMatchObject({ locked: true });
      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: replacementOwnerPid }),
      ).rejects.toThrow("Another Paseo daemon is already running");

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(process.pid);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("preserves a stale live desktop heartbeat lock", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-stale-desktop-heartbeat-"));
    const replacementOwnerPid = process.pid + 10_000;

    try {
      const pidPath = join(paseoHome, "paseo.pid");
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00.000Z",
          hostname: "old-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
          heartbeat: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: replacementOwnerPid }),
      ).rejects.toThrow("Another Paseo daemon is already running");

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(process.pid);
      expect(lock?.listen).toBe("127.0.0.1:6767");
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("keeps a stale live lock written by a pre-heartbeat daemon", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-legacy-live-"));
    const pidPath = join(paseoHome, "paseo.pid");

    try {
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00.000Z",
          hostname: "old-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: process.pid + 10_000 }),
      ).rejects.toThrow("Another Paseo daemon is already running");

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(process.pid);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("preserves a stale live legacy desktop lock", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-legacy-desktop-"));
    const replacementOwnerPid = process.pid + 10_000;
    const pidPath = join(paseoHome, "paseo.pid");

    try {
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00.000Z",
          hostname: "old-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: replacementOwnerPid }),
      ).rejects.toThrow("Another Paseo daemon is already running");

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(process.pid);
      expect(lock?.heartbeat).toBeUndefined();
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("rejects a heartbeat refresh after another supervisor takes ownership", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-refresh-owner-"));

    try {
      await acquirePidLock(paseoHome, null, { ownerPid: process.pid + 10_000 });

      await expect(refreshPidLock(paseoHome, { ownerPid: process.pid })).rejects.toBeInstanceOf(
        PidLockError,
      );
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("retries a heartbeat refresh while its owner is rewriting the lock", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-refresh-rewrite-"));
    const pidPath = join(paseoHome, "paseo.pid");

    try {
      await acquirePidLock(paseoHome, null, { ownerPid: process.pid });
      const lock = await getPidLockInfo(paseoHome);
      expect(lock).not.toBeNull();

      const rewriteHandle = await open(pidPath, "r+");
      await rewriteHandle.truncate(0);

      const refresh = refreshPidLock(paseoHome, { ownerPid: process.pid });
      await new Promise((resolve) => setTimeout(resolve, 250));
      await rewriteHandle.writeFile(JSON.stringify(lock));
      await rewriteHandle.close();

      await expect(refresh).resolves.toBeUndefined();
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("keeps a fresh lock when the recorded pid is alive", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-fresh-heartbeat-"));

    try {
      await writeFile(
        join(paseoHome, "paseo.pid"),
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: "current-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
          heartbeat: true,
        }),
      );

      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: process.pid + 10_000 }),
      ).rejects.toThrow("Another Paseo daemon is already running");

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(process.pid);
      expect(lock?.listen).toBe("127.0.0.1:6767");
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });
});

describe("pid-lock recovery from a lock file with no readable owner", () => {
  test("acquires the lock after a zero-byte lock file is left behind", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-empty-"));
    const ownerPid = process.pid + 10_000;

    try {
      // What a daemon killed between the exclusive create and the write leaves.
      await writeFile(join(paseoHome, "paseo.pid"), "");

      await acquirePidLock(paseoHome, null, { ownerPid });

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(ownerPid);
      expect(lock?.heartbeat).toBe(true);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("acquires the lock after a lock file that parses but has no valid pid", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-truncated-"));
    const ownerPid = process.pid + 10_000;

    try {
      await writeFile(join(paseoHome, "paseo.pid"), JSON.stringify({ pid: 0 }));

      await acquirePidLock(paseoHome, null, { ownerPid });

      expect((await getPidLockInfo(paseoHome))?.pid).toBe(ownerPid);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("keeps the path and reports the failure when the lock cannot be read at all", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-unreadable-"));

    try {
      // A directory in place of the lock file fails the read for a reason that
      // is not its contents, so it must not be treated as an abandoned lock.
      await mkdir(join(paseoHome, "paseo.pid"));

      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: process.pid + 10_000 }),
      ).rejects.toThrow(PidLockError);

      expect((await stat(join(paseoHome, "paseo.pid"))).isDirectory()).toBe(true);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });
});

/**
 * The guard that keeps the recovery path from deleting a lock that became
 * valid after it was read: the entry it deletes must still be the entry it
 * decided about. The interleaving itself is a few instructions wide, so the
 * predicate is exercised directly against real files.
 */
describe("pid-lock file identity", () => {
  test("an untouched file is the same entry when stat'ed again", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-pid-same-"));
    try {
      const path = join(home, "paseo.pid");
      await writeFile(path, "");

      expect(isSameFileEntry(await stat(path), await stat(path))).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a file written to since the first stat is not the same entry", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-pid-written-"));
    try {
      // What the daemon that created the empty lock does a moment later.
      const path = join(home, "paseo.pid");
      await writeFile(path, "");
      const beforeWrite = await stat(path);

      await writeFile(path, JSON.stringify({ pid: 4242 }));

      expect(isSameFileEntry(beforeWrite, await stat(path))).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a file rewritten to the same length at a new time is not the same entry", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-pid-retouched-"));
    try {
      const path = join(home, "paseo.pid");
      await writeFile(path, "aaaa");
      const beforeRewrite = await stat(path);

      await writeFile(path, "bbbb");
      const later = new Date(beforeRewrite.mtimeMs + 5_000);
      await utimes(path, later, later);

      expect(isSameFileEntry(beforeRewrite, await stat(path))).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a rewrite that keeps the inode and the time is caught by the size", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-pid-grew-"));
    try {
      // Exactly the case the guard exists for: the daemon that created the
      // empty lock fills it in. Same file, same clock reading, more bytes.
      // Pin the time on both sides: utimes rounds to whole milliseconds, so a
      // time read back from stat cannot be written again unchanged.
      const pinned = new Date(1_700_000_000_000);
      const path = join(home, "paseo.pid");
      await writeFile(path, "");
      await utimes(path, pinned, pinned);
      const beforeFill = await stat(path);

      await writeFile(path, JSON.stringify({ pid: 4242 }));
      await utimes(path, pinned, pinned);

      const afterFill = await stat(path);
      expect(afterFill.ino).toBe(beforeFill.ino);
      expect(afterFill.mtimeMs).toBe(beforeFill.mtimeMs);
      expect(isSameFileEntry(beforeFill, afterFill)).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a replacement that keeps the size and the time is caught by the inode", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-pid-swapped-"));
    try {
      // Another daemon's exclusive create after the file was removed. Nothing
      // but the inode distinguishes it from the file that was read.
      const pinned = new Date(1_700_000_000_000);
      const path = join(home, "paseo.pid");
      await writeFile(path, "");
      await utimes(path, pinned, pinned);
      const beforeSwap = await stat(path);

      await rm(path);
      await writeFile(path, "");
      await utimes(path, pinned, pinned);

      const afterSwap = await stat(path);
      expect(afterSwap.size).toBe(beforeSwap.size);
      expect(afterSwap.mtimeMs).toBe(beforeSwap.mtimeMs);
      expect(afterSwap.ino).not.toBe(beforeSwap.ino);
      expect(isSameFileEntry(beforeSwap, afterSwap)).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a replacement at the same path is not the same entry", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-pid-replaced-"));
    try {
      // What another daemon's exclusive create leaves after the file is gone:
      // same path, same contents, different inode.
      const path = join(home, "paseo.pid");
      await writeFile(path, "");
      const beforeReplace = await stat(path);

      await rm(path);
      await writeFile(path, "");

      expect(isSameFileEntry(beforeReplace, await stat(path))).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
