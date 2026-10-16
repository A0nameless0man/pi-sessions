import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// pi retires an extension ctx after session replacement (new/resume/fork) or
// /reload: every getter on it (ui, sessionManager, ...) throws once the owning
// runner is gone. Closures that capture a ctx and run later — index recovery
// notices, fire-and-forget sync chains — must tolerate that throw, because an
// escaping rejection from a void-ed promise chain surfaces as an
// uncaughtException that kills pi.

export function isStaleContextError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("ctx is stale");
}

/**
 * Best-effort notify that never throws. Drops the message when the ctx went
 * stale after session replacement or reload; falls back to console.error for
 * any other failure so real bugs stay visible. Designed for post-await
 * touches of a captured ctx, where the next session_start re-registers with
 * a fresh ctx and re-reports current state.
 */
export function safeNotify(
  ctx: Pick<ExtensionContext, "ui">,
  message: string,
  level: "info" | "warning" | "error",
): void {
  try {
    ctx.ui.notify(message, level);
  } catch (error) {
    if (!isStaleContextError(error)) console.error(message);
  }
}
