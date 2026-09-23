import { describe, expect, it, vi } from "vitest";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { FailoverError } from "../failover-error.js";
import { runCliRecovery } from "./cli-run-recovery.js";
import type { PreparedCliRunContext } from "./types.js";

const NATIVE_REFRESH_CONTENTION_MESSAGE =
  "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again";

function nativeRefreshContentionError(): FailoverError {
  return new FailoverError(NATIVE_REFRESH_CONTENTION_MESSAGE, {
    reason: "unknown",
    provider: "claude-cli",
    model: "claude-opus-4-8",
  });
}

function reuseCliContext(timeoutMs: number): PreparedCliRunContext {
  const context = buildPreparedCliRunContext({
    sessionKey: "agent:main:main",
    timeoutMs,
    provider: "claude-cli",
    model: "claude-opus-4-8",
  });
  context.reusableCliSession = { mode: "reuse", sessionId: "session-1" };
  return context;
}

describe("cli-run-recovery retry budget", () => {
  it("keeps recovery budget after a forward wall-clock step", async () => {
    const context = buildPreparedCliRunContext({
      sessionKey: "agent:main:main",
      timeoutMs: 60_000,
    });
    context.openClawHistoryPrompt = "…earlier history…";
    context.reusableCliSession = { mode: "reuse", sessionId: "s1" };
    const error = new FailoverError("selected session expired", {
      reason: "session_expired",
      provider: "claude-cli",
    });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(context.started + 120_000);
    let attempts = 0;
    try {
      const result = await runCliRecovery({
        context,
        executeAttempt: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw error;
          }
          return { done: true };
        },
        finishAttempt: async (attempt) => ({ ...attempt, meta: { durationMs: 1 } }),
        finishDeliveredFailure: async () => undefined,
        onTerminalFailure: async () => {},
      });
      expect(result).toEqual({ done: true, meta: { durationMs: 1 } });
      expect(attempts).toBe(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("passes an integer retry timeout to the next attempt when elapsed monotonic time is fractional", async () => {
    const context = buildPreparedCliRunContext({
      sessionKey: "agent:main:main",
      timeoutMs: 60_000,
    });
    context.openClawHistoryPrompt = "…earlier history…";
    context.reusableCliSession = { mode: "reuse", sessionId: "s1" };

    // Fractional elapsed monotonic time (12345.4ms) makes a naive subtraction
    // yield a fractional retry budget (47654.6ms) that the paired-node remote
    // decoder would reject (Number.isInteger). The budget must be floored.
    const nowSpy = vi.spyOn(performance, "now").mockReturnValue(12_345.4);
    context.startedMonotonicMs = 0;

    let retryTimeoutMs: number | undefined;
    let firstAttempt = true;
    const result = await runCliRecovery({
      context,
      executeAttempt: async (_sessionId, options) => {
        if (firstAttempt) {
          firstAttempt = false;
          throw new FailoverError("selected session expired", {
            reason: "session_expired",
            provider: "claude-cli",
          });
        }
        retryTimeoutMs = options?.timeoutMs;
        return { done: true };
      },
      finishAttempt: async (attempt) => ({ ...attempt, meta: { durationMs: 1 } }),
      finishDeliveredFailure: async () => undefined,
      onTerminalFailure: async () => {},
    });

    expect(retryTimeoutMs).toBe(47_654); // Math.floor(60000 - 12345.4), not 47655
    expect(Number.isInteger(retryTimeoutMs)).toBe(true);
    expect(result).toEqual({ done: true, meta: { durationMs: 1 } });
    nowSpy.mockRestore();
  });

  it("treats a consumed retry budget as expired instead of passing a non-positive timeout", async () => {
    const context = buildPreparedCliRunContext({
      sessionKey: "agent:main:main",
      timeoutMs: 1_000,
    });
    context.openClawHistoryPrompt = "…earlier history…";
    context.reusableCliSession = { mode: "reuse", sessionId: "s1" };

    // More elapsed monotonic time than the whole budget (2000.9ms consumed,
    // 1000ms budget): the remaining budget is negative and must be treated as
    // expired rather than passed to a retry attempt.
    const nowSpy = vi.spyOn(performance, "now").mockReturnValue(2_000.9);
    context.startedMonotonicMs = 0;

    const error = new FailoverError("selected session expired", {
      reason: "session_expired",
      provider: "claude-cli",
    });
    let attempts = 0;
    await expect(
      runCliRecovery({
        context,
        executeAttempt: async () => {
          attempts += 1;
          throw error;
        },
        finishAttempt: async () => ({ meta: { durationMs: 1 } }),
        finishDeliveredFailure: async () => undefined,
        onTerminalFailure: async () => {},
      }),
    ).rejects.toBe(error);

    expect(attempts).toBe(1); // only the original attempt; no retry with an expired budget
    nowSpy.mockRestore();
  });
});

describe("cli-run-recovery native refresh contention", () => {
  async function withFakeTimers(run: () => Promise<void>): Promise<void> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await run();
    } finally {
      vi.useRealTimers();
    }
  }

  it("retries the same CLI session once after native refresh-lock contention", async () => {
    await withFakeTimers(async () => {
      const context = reuseCliContext(180_000);
      const sessions: Array<string | undefined> = [];
      const retryTimeouts: Array<number | undefined> = [];
      let attempts = 0;
      const pending = runCliRecovery({
        context,
        executeAttempt: async (sessionId, options) => {
          attempts += 1;
          sessions.push(sessionId);
          retryTimeouts.push(options?.timeoutMs);
          if (attempts === 1) {
            throw nativeRefreshContentionError();
          }
          return { done: true };
        },
        finishAttempt: async (attempt) => ({ ...attempt, meta: { durationMs: 1 } }),
        finishDeliveredFailure: async () => undefined,
        onTerminalFailure: async () => {},
      });

      await vi.advanceTimersByTimeAsync(59_000);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toEqual({ done: true, meta: { durationMs: 1 } });
      expect(sessions).toEqual(["session-1", "session-1"]);
      expect(retryTimeouts[1]).toEqual(expect.any(Number));
      expect(Number.isInteger(retryTimeouts[1])).toBe(true);
      expect(retryTimeouts[1] ?? 0).toBeGreaterThan(0);
      expect(retryTimeouts[1] ?? 0).toBeLessThan(180_000);
    });
  });

  it("stops after a second native refresh-lock failure", async () => {
    await withFakeTimers(async () => {
      const context = reuseCliContext(180_000);
      const error = nativeRefreshContentionError();
      const terminal: unknown[] = [];
      let attempts = 0;
      const pending = runCliRecovery({
        context,
        executeAttempt: async () => {
          attempts += 1;
          throw error;
        },
        finishAttempt: async () => ({ meta: { durationMs: 1 } }),
        finishDeliveredFailure: async () => undefined,
        onTerminalFailure: async (failure) => {
          terminal.push(failure);
        },
      });
      const rejected = expect(pending).rejects.toBe(error);

      await vi.advanceTimersByTimeAsync(60_000);
      await rejected;
      expect(attempts).toBe(2);
      expect(terminal).toEqual([error]);
    });
  });

  it("does not wait when the remaining budget cannot cover the refresh-lock delay", async () => {
    await withFakeTimers(async () => {
      const context = reuseCliContext(30_000);
      const error = nativeRefreshContentionError();
      let attempts = 0;
      const pending = runCliRecovery({
        context,
        executeAttempt: async () => {
          attempts += 1;
          throw error;
        },
        finishAttempt: async () => ({ meta: { durationMs: 1 } }),
        finishDeliveredFailure: async () => undefined,
        onTerminalFailure: async () => {},
      });

      await expect(pending).rejects.toBe(error);
      expect(attempts).toBe(1);
    });
  });

  it("does not retry a delivered failure or a different OAuth refresh error", async () => {
    await withFakeTimers(async () => {
      const delivered = { meta: { durationMs: 1 } };
      let contentionAttempts = 0;
      const deliveredRun = runCliRecovery({
        context: reuseCliContext(180_000),
        executeAttempt: async () => {
          contentionAttempts += 1;
          throw nativeRefreshContentionError();
        },
        finishAttempt: async () => delivered,
        finishDeliveredFailure: async () => delivered,
        onTerminalFailure: async () => {},
      });
      await expect(deliveredRun).resolves.toBe(delivered);
      expect(contentionAttempts).toBe(1);

      const other = new FailoverError(
        "OAuth token refresh failed for anthropic: Failed to refresh OAuth token for anthropic. Please try again or re-authenticate.",
        { reason: "unknown", provider: "claude-cli" },
      );
      let otherAttempts = 0;
      const otherRun = runCliRecovery({
        context: reuseCliContext(180_000),
        executeAttempt: async () => {
          otherAttempts += 1;
          throw other;
        },
        finishAttempt: async () => ({ meta: { durationMs: 1 } }),
        finishDeliveredFailure: async () => undefined,
        onTerminalFailure: async () => {},
      });
      await expect(otherRun).rejects.toBe(other);
      expect(otherAttempts).toBe(1);
    });
  });

  it("returns a delivered retry instead of treating the second attempt as terminal", async () => {
    await withFakeTimers(async () => {
      const context = reuseCliContext(180_000);
      const delivered = { meta: { durationMs: 1 } };
      const terminal: unknown[] = [];
      let attempts = 0;
      const pending = runCliRecovery({
        context,
        executeAttempt: async () => {
          attempts += 1;
          throw nativeRefreshContentionError();
        },
        finishAttempt: async () => delivered,
        finishDeliveredFailure: async () => (attempts >= 2 ? delivered : undefined),
        onTerminalFailure: async (failure) => {
          terminal.push(failure);
        },
      });

      await vi.advanceTimersByTimeAsync(60_000);
      await expect(pending).resolves.toBe(delivered);
      expect(attempts).toBe(2);
      expect(terminal).toEqual([]);
    });
  });

  it("cancels the refresh-lock wait without a second attempt", async () => {
    await withFakeTimers(async () => {
      const context = reuseCliContext(180_000);
      const controller = new AbortController();
      context.params.abortSignal = controller.signal;
      const terminal: unknown[] = [];
      let attempts = 0;
      const pending = runCliRecovery({
        context,
        executeAttempt: async () => {
          attempts += 1;
          throw nativeRefreshContentionError();
        },
        finishAttempt: async () => ({ meta: { durationMs: 1 } }),
        finishDeliveredFailure: async () => undefined,
        onTerminalFailure: async (failure) => {
          terminal.push(failure);
        },
      });
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(1_000);
      controller.abort();
      await rejected;
      expect(attempts).toBe(1);
      expect(terminal).toEqual([]);
    });
  });
});
