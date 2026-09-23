import { isAbortError, racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { formatErrorMessageForDisplay } from "../../infra/error-diagnostics.js";
import { isCliSessionInvalidatingFailoverReason } from "../cli-session.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent-runner.js";
import { type FailoverError, isFailoverError } from "../failover-error.js";
import { cliBackendLog } from "./log.js";
import type { CliReusableSession, PreparedCliRunContext } from "./types.js";

/**
 * Claude Code emits this before the turn starts, while another process holds
 * `~/.claude/.oauth_refresh.lock`. One wait-and-retry keeps the same session
 * and model. A second hit is terminal, so the caller can still fail over.
 */
const NATIVE_CLI_REFRESH_CONTENTION_RETRY_MS = 60_000;
const NATIVE_CLI_REFRESH_CONTENTION_RE =
  /failed to refresh oauth token: another claude code process is refreshing it or exited mid-refresh/i;

export type CliRecoveryOptions = {
  timeoutMs?: number;
  forkCliSessionOnResume?: boolean;
  resumeAt?: string;
  onForkSuccessorPersisted?: (sessionId: string) => void;
};

export function resolveCliSessionId(reusableCliSession: CliReusableSession): string | undefined {
  return reusableCliSession.mode === "reuse" || reusableCliSession.mode === "reuse-with-drift"
    ? reusableCliSession.sessionId
    : undefined;
}

function shouldRetryFreshCliSessionAfterFailover(params: {
  error: FailoverError;
  hasHistoryPrompt: boolean;
  recoveryPolicy?: "replace-binding" | "invalidated-only";
}): boolean {
  if (!params.hasHistoryPrompt) {
    return false;
  }
  // Some CLIs can safely replace a resumable conversation after transport or
  // format failures. Backends that cannot must positively prove invalidation.
  if (
    params.recoveryPolicy === "invalidated-only" &&
    !isCliSessionInvalidatingFailoverReason(params.error.reason)
  ) {
    return false;
  }
  switch (params.error.reason) {
    case "session_expired":
      return true;
    case "unknown":
      return params.error.code === "cli_unknown_empty_failure";
    case "empty_response":
      return params.error.code === "cli_unknown_empty_failure";
    case "format":
      return params.error.code === "cli_synthetic_no_response";
    case "timeout":
      return params.error.code === "cli_no_output_timeout";
    case "context_overflow":
      return params.error.code === "cli_context_overflow";
    default:
      return false;
  }
}

function shouldRetryForkedCliSessionAfterFailover(error: FailoverError): boolean {
  return error.reason === "timeout" && error.code === "cli_no_output_timeout";
}

function isNativeCliRefreshContention(error: unknown): error is FailoverError {
  return isFailoverError(error) && NATIVE_CLI_REFRESH_CONTENTION_RE.test(error.message);
}

async function waitForCliRecoveryDelay(waitMs: number, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs);
  });
  try {
    await racePromiseWithAbortSignal(elapsed, signal);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Remaining retry budget measured against the run's monotonic anchor. Elapsed
 * monotonic time is fractional, so the result is floored to a whole millisecond:
 * this keeps the retry within the operator-configured budget and satisfies the
 * paired-node remote decoder's `Number.isInteger` timeout contract.
 */
function remainingCliRecoveryBudgetMs(timeoutMs: number, startedMonotonicMs: number): number {
  return Math.floor(timeoutMs - (performance.now() - startedMonotonicMs));
}

export async function runCliRecovery<TAttempt>(params: {
  context: PreparedCliRunContext;
  executeAttempt: (cliSessionIdToUse?: string, options?: CliRecoveryOptions) => Promise<TAttempt>;
  finishAttempt: (
    attempt: TAttempt,
    fallbackCliSessionId?: string,
  ) => Promise<EmbeddedAgentRunResult>;
  finishDeliveredFailure: (error: unknown) => Promise<EmbeddedAgentRunResult | undefined>;
  onTerminalFailure: (error: unknown) => Promise<void>;
}): Promise<EmbeddedAgentRunResult> {
  const { context } = params;
  const runParams = context.params;
  const reusableCliSessionId = resolveCliSessionId(context.reusableCliSession);
  const resumeCheckpointId = runParams.cliSessionBinding?.resumeCheckpointId;
  let retryableSessionId = reusableCliSessionId;
  const failTerminal = async (error: unknown): Promise<never> => {
    // Record only after every eligible recovery path is exhausted.
    cliBackendLog.warn(
      `cli terminal failure: provider=${runParams.provider} model=${context.modelId} durationMs=${Date.now() - context.started} runId=${runParams.runId} error=${formatErrorMessageForDisplay(error)}`,
    );
    await params.onTerminalFailure(error);
    throw error;
  };
  try {
    return await params.finishAttempt(
      await params.executeAttempt(
        reusableCliSessionId,
        runParams.forkCliSessionOnResume
          ? {
              onForkSuccessorPersisted: (sessionId) => {
                retryableSessionId = sessionId;
              },
            }
          : undefined,
      ),
      reusableCliSessionId,
    );
  } catch (err) {
    const deliveredFailure = await params.finishDeliveredFailure(err);
    if (deliveredFailure) {
      return deliveredFailure;
    }
    runParams.assertCurrent?.();
    let recoveryError = err;
    if (isNativeCliRefreshContention(recoveryError)) {
      const budgetBeforeWaitMs = remainingCliRecoveryBudgetMs(
        runParams.timeoutMs,
        context.startedMonotonicMs,
      );
      if (budgetBeforeWaitMs <= NATIVE_CLI_REFRESH_CONTENTION_RETRY_MS) {
        return await failTerminal(recoveryError);
      }
      await waitForCliRecoveryDelay(NATIVE_CLI_REFRESH_CONTENTION_RETRY_MS, runParams.abortSignal);
      runParams.assertCurrent?.();
      try {
        const retryTimeoutMs = remainingCliRecoveryBudgetMs(
          runParams.timeoutMs,
          context.startedMonotonicMs,
        );
        if (retryTimeoutMs <= 0) {
          throw recoveryError;
        }
        cliBackendLog.warn(
          `cli refresh contention retry: provider=${runParams.provider} model=${context.modelId} runId=${runParams.runId}`,
        );
        return await params.finishAttempt(
          await params.executeAttempt(reusableCliSessionId, { timeoutMs: retryTimeoutMs }),
          reusableCliSessionId,
        );
      } catch (retryErr) {
        const deliveredRetryFailure = await params.finishDeliveredFailure(retryErr);
        if (deliveredRetryFailure) {
          return deliveredRetryFailure;
        }
        runParams.assertCurrent?.();
        if (isAbortError(retryErr)) {
          throw retryErr;
        }
        if (isNativeCliRefreshContention(retryErr)) {
          return await failTerminal(retryErr);
        }
        recoveryError = retryErr;
      }
    }
    if (isFailoverError(recoveryError)) {
      if (
        !runParams.forkCliSessionOnResume &&
        shouldRetryForkedCliSessionAfterFailover(recoveryError) &&
        retryableSessionId &&
        resumeCheckpointId &&
        runParams.sessionKey &&
        context.preparedBackend.backend.forkArg &&
        context.preparedBackend.backend.resumeAtArg &&
        runParams.onBeforeForkedCliSessionRetry
      ) {
        try {
          // Elapsed time is monotonic so a wall-clock step cannot consume or
          // extend the operator-configured retry budget.
          const retryTimeoutMs = remainingCliRecoveryBudgetMs(
            runParams.timeoutMs,
            context.startedMonotonicMs,
          );
          if (retryTimeoutMs <= 0) {
            throw recoveryError;
          }
          const forkPrepared = await runParams.onBeforeForkedCliSessionRetry({
            provider: runParams.provider,
            reason: recoveryError.reason,
            sessionId: retryableSessionId,
          });
          if (!forkPrepared) {
            throw recoveryError;
          }
          cliBackendLog.warn(
            `cli session recovery fork: provider=${runParams.provider} reason=${recoveryError.reason} sessionKey=${runParams.sessionKey}`,
          );
          return await params.finishAttempt(
            await params.executeAttempt(retryableSessionId, {
              timeoutMs: retryTimeoutMs,
              forkCliSessionOnResume: true,
              resumeAt: resumeCheckpointId,
              onForkSuccessorPersisted: (sessionId) => {
                retryableSessionId = sessionId;
              },
            }),
          );
        } catch (forkError) {
          const deliveredForkFailure = await params.finishDeliveredFailure(forkError);
          if (deliveredForkFailure) {
            return deliveredForkFailure;
          }
          runParams.assertCurrent?.();
          recoveryError =
            isFailoverError(forkError) && forkError.code === "cli_resume_at_unsupported"
              ? err
              : forkError;
        }
      }
      if (
        isFailoverError(recoveryError) &&
        shouldRetryFreshCliSessionAfterFailover({
          error: recoveryError,
          hasHistoryPrompt: Boolean(context.openClawHistoryPrompt),
          recoveryPolicy: context.preparedBackend.backend.freshSessionRecovery,
        }) &&
        retryableSessionId &&
        runParams.sessionKey
      ) {
        try {
          const retryTimeoutMs = remainingCliRecoveryBudgetMs(
            runParams.timeoutMs,
            context.startedMonotonicMs,
          );
          if (retryTimeoutMs <= 0) {
            throw recoveryError;
          }
          if (runParams.onBeforeFreshCliSessionRetry) {
            const clearedStaleBinding = await runParams.onBeforeFreshCliSessionRetry({
              provider: runParams.provider,
              reason: recoveryError.reason,
              sessionId: retryableSessionId,
            });
            if (!clearedStaleBinding) {
              throw recoveryError;
            }
          }
          cliBackendLog.warn(
            `cli session recovery retry: provider=${runParams.provider} reason=${recoveryError.reason} sessionKey=${runParams.sessionKey}`,
          );
          return await params.finishAttempt(
            await params.executeAttempt(undefined, {
              timeoutMs: retryTimeoutMs,
              forkCliSessionOnResume: false,
            }),
          );
        } catch (retryErr) {
          const deliveredRetryFailure = await params.finishDeliveredFailure(retryErr);
          if (deliveredRetryFailure) {
            return deliveredRetryFailure;
          }
          return await failTerminal(retryErr);
        }
      }
    }
    return await failTerminal(recoveryError);
  }
}
