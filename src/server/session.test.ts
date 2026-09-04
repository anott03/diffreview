import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { clearSession, readSession, Session, writeSession } from "./session";
import { sessionPathForRepo } from "./paths";

// Session files live under $XDG_DATA_HOME/diff-review — point it at a temp
// dir so tests never touch the real user data dir. paths.ts reads the env
// var on every call, so no import-order tricks are needed.
let dataHome: string;

beforeEach(() => {
  dataHome = mkdtempSync(join(tmpdir(), "diffreview-session-"));
  process.env.XDG_DATA_HOME = dataHome;
});

afterEach(() => {
  delete process.env.XDG_DATA_HOME;
  rmSync(dataHome, { recursive: true, force: true });
});

const INFO = {
  port: 4777,
  pid: process.pid,
  repoRoot: "/tmp/some-repo",
  startedAt: 1700000000000,
};

describe("Session (Effect service)", () => {
  const withSession = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(Session.layer));

  it.effect("writes and reads back a session file", () =>
    Effect.gen(function*() {
      const session = yield* Session;
      yield* session.write(INFO);
      expect(yield* session.read(INFO.repoRoot)).toEqual(INFO);
    }).pipe(withSession));

  it.effect("write overwrites an existing session file", () =>
    Effect.gen(function*() {
      const session = yield* Session;
      yield* session.write(INFO);
      const updated = { ...INFO, port: 5000 };
      yield* session.write(updated);
      expect(yield* session.read(INFO.repoRoot)).toEqual(updated);
    }).pipe(withSession));

  it.effect("read returns null when the file is missing", () =>
    Effect.gen(function*() {
      const session = yield* Session;
      expect(yield* session.read("/nowhere/repo")).toBeNull();
    }).pipe(withSession));

  it.effect("read tolerates a corrupt session file (mcp discovery)", () =>
    Effect.gen(function*() {
      const session = yield* Session;
      yield* session.write(INFO);
      // Corrupt the file directly at the same path the free fn uses.
      writeFileSync(sessionPathForRepo(INFO.repoRoot), "{ not json");
      expect(yield* session.read(INFO.repoRoot)).toBeNull();
    }).pipe(withSession));

  it.effect("clear removes the file and is idempotent", () =>
    Effect.gen(function*() {
      const session = yield* Session;
      yield* session.write(INFO);
      yield* session.clear(INFO.repoRoot);
      expect(yield* session.read(INFO.repoRoot)).toBeNull();
      // Second clear: still succeeds (already gone).
      yield* session.clear(INFO.repoRoot);
      expect(yield* session.read(INFO.repoRoot)).toBeNull();
    }).pipe(withSession));

  it("free-function bridge matches service behavior (mcp discovery)", () => {
    writeSession(INFO);
    expect(readSession(INFO.repoRoot)).toEqual(INFO);
    clearSession(INFO.repoRoot);
    expect(readSession(INFO.repoRoot)).toBeNull();
    // Idempotent.
    clearSession(INFO.repoRoot);
    expect(readSession(INFO.repoRoot)).toBeNull();
  });
});
