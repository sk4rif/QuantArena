import { describe, expect, it } from "vitest";
import { AuthError, UnavailableAuthService } from "./service";

describe("UnavailableAuthService", () => {
  const service = new UnavailableAuthService();

  it("starts as a guest", () => {
    expect(service.user).toBeNull();
  });

  it("rejects sign-in and sign-up with a player-safe error", async () => {
    await expect(service.signIn()).rejects.toBeInstanceOf(AuthError);
    await expect(service.signUp()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("signs out without error", async () => {
    await expect(service.signOut()).resolves.toBeUndefined();
  });
});
