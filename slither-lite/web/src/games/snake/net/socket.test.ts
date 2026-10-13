import { describe, expect, it } from "vitest";
import type { InputState } from "../game/input";
import {
  INPUT_KEEPALIVE_MS,
  ResyncController,
  shouldSendInput,
  type SentInput,
} from "./socket";

function input(aim: number, boost = false): InputState {
  return { aim, boost, panX: 0, panY: 0 };
}

describe("shouldSendInput", () => {
  it("sends the first sample, meaningful aim changes, boost toggles, and keepalives", () => {
    expect(shouldSendInput(input(0), undefined, 0)).toBe(true);
    const last: SentInput = { aim: 0, boost: false, sentAt: 0 };
    expect(shouldSendInput(input(0), last, INPUT_KEEPALIVE_MS - 1)).toBe(false);
    expect(shouldSendInput(input((0.02 * Math.PI) / 180), last, 10)).toBe(false);
    expect(shouldSendInput(input((0.4 * Math.PI) / 180), last, 10)).toBe(true);
    expect(shouldSendInput(input(Math.PI / 180), last, 10)).toBe(true);
    expect(shouldSendInput(input(0, true), last, 10)).toBe(true);
    expect(shouldSendInput(input(0), last, INPUT_KEEPALIVE_MS)).toBe(true);
  });

  it("treats a wrap across ±π as a small aim change", () => {
    const last: SentInput = { aim: Math.PI - 0.0001, boost: false, sentAt: 0 };
    expect(shouldSendInput(input(-Math.PI + 0.0001), last, 10)).toBe(false);
    expect(shouldSendInput(input(-Math.PI + 0.002), last, 10)).toBe(true);
  });

  it("advances the input sequence only when a message is sent", () => {
    let sequence = 0;
    let last: SentInput | undefined;
    const state = input(0);
    const tick = (now: number) => {
      if (!shouldSendInput(state, last, now)) return;
      sequence += 1;
      last = { aim: state.aim, boost: state.boost, sentAt: now };
    };
    tick(0);
    tick(16);
    tick(32);
    expect(sequence).toBe(1);
    state.boost = true;
    tick(40);
    expect(sequence).toBe(2);
    tick(40 + INPUT_KEEPALIVE_MS);
    expect(sequence).toBe(3);
  });
});

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
