import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { isStaleContextError, safeNotify } from "../extensions/shared/ctx-safety.ts";

// Mirrors pi's ExtensionRunner.assertActive() throw, which reached us as an
// uncaughtException via stale closures captured across session replacement.
function staleError(): Error {
  return new Error(
    "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().",
  );
}

it("classifies pi's stale-ctx error", () => {
  expect(isStaleContextError(staleError())).toBe(true);
  expect(isStaleContextError(new Error("boom"))).toBe(false);
  expect(isStaleContextError("not an error")).toBe(false);
  expect(isStaleContextError(undefined)).toBe(false);
});

it("safeNotify drops the message on a stale ctx and never throws", () => {
  const ctx = {
    get ui(): never {
      throw staleError();
    },
  } as unknown as ExtensionContext;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(() => safeNotify(ctx, "stale drop", "error")).not.toThrow();
  expect(errorSpy).not.toHaveBeenCalled();
  errorSpy.mockRestore();
});

it("safeNotify falls back to console.error for non-stale failures", () => {
  const ctx = {
    get ui(): never {
      throw new Error("boom");
    },
  } as unknown as ExtensionContext;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(() => safeNotify(ctx, "visible fallback", "warning")).not.toThrow();
  expect(errorSpy).toHaveBeenCalledWith("visible fallback");
  errorSpy.mockRestore();
});

it("safeNotify forwards to ui.notify when the ctx is live", () => {
  const notify = vi.fn();
  const ctx = { ui: { notify } } as unknown as ExtensionContext;
  safeNotify(ctx, "forwarded", "info");
  expect(notify).toHaveBeenCalledWith("forwarded", "info");
});
