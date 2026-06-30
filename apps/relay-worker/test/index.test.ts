// test/index.test.ts
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("Worker entry", () => {
  it("rejeita sem Upgrade: websocket", async () => {
    const res = await SELF.fetch("https://relay.test/r/abcdefgh");
    expect(res.status).toBe(426);
  });
  it("rejeita path fora de /r/<token>", async () => {
    const res = await SELF.fetch("https://relay.test/foo", { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(404);
  });
});
