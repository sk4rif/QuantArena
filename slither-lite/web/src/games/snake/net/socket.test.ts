import { describe, expect, it } from "vitest";
import { ResyncController } from "./socket";

describe("ResyncController", () => {
  it("ignores one digest mismatch and rate-limits the resync after the second", () => {
    const controller = new ResyncController();
    expect(controller.digestMismatch(0)).toEqual({ resyncing: false, send: null });
    controller.synchronized();
    expect(controller.digestMismatch(10)).toEqual({ resyncing: false, send: null });

    const again = new ResyncController();
    expect(again.digestMismatch(0)).toEqual({ resyncing: false, send: null });
    expect(again.digestMismatch(10)).toEqual({ resyncing: true, send: "digestMismatch" });
    expect(again.digestMismatch(20)).toEqual({ resyncing: false, send: null });
    expect(again.digestMismatch(30)).toEqual({ resyncing: true, send: null });
    expect(again.poll(10 + 999)).toBeNull();
    expect(again.poll(10 + 1000)).toBe("digestMismatch");
  });

  it("requests a sequence-gap resync immediately and retries after the rate limit", () => {
    const controller = new ResyncController();
    expect(controller.sequenceGap(0)).toEqual({ resyncing: true, send: "sequenceGap" });
    expect(controller.sequenceGap(100)).toEqual({ resyncing: true, send: null });
    expect(controller.digestMismatch(200).send).toBeNull();
    expect(controller.poll(1000)).toBe("sequenceGap");
  });

  it("drops a queued digest resync when a later snapshot matches", () => {
    const controller = new ResyncController();
    expect(controller.digestMismatch(0).send).toBeNull();
    expect(controller.digestMismatch(10).send).toBe("digestMismatch");
    expect(controller.digestMismatch(20).resyncing).toBe(false);
    expect(controller.digestMismatch(30)).toEqual({ resyncing: true, send: null });
    controller.synchronized();
    expect(controller.poll(2_000)).toBeNull();
  });
});
