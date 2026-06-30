// test/room.test.ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("RoomDO bridge", () => {
  it("repassa um frame de um socket pro outro do mesmo room", async () => {
    const id = env.ROOMS.idFromName("token-abc");
    const stub = env.ROOMS.get(id);

    // 2 conexões no mesmo room
    const a = await stub.fetch("https://r/r/token-abc", { headers: { Upgrade: "websocket" } });
    const b = await stub.fetch("https://r/r/token-abc", { headers: { Upgrade: "websocket" } });
    const wsA = a.webSocket!; const wsB = b.webSocket!;
    wsA.accept(); wsB.accept();

    const got = new Promise<string>((res) => wsB.addEventListener("message", (e) => res(String(e.data))));
    wsA.send("ola-cifrado");
    expect(await got).toBe("ola-cifrado");
  });

  it("não vaza frame entre rooms diferentes", async () => {
    const sA = env.ROOMS.get(env.ROOMS.idFromName("room-1"));
    const sB = env.ROOMS.get(env.ROOMS.idFromName("room-2"));
    const a = (await sA.fetch("https://r/r/room-1", { headers: { Upgrade: "websocket" } })).webSocket!;
    const b = (await sB.fetch("https://r/r/room-2", { headers: { Upgrade: "websocket" } })).webSocket!;
    a.accept(); b.accept();
    let leaked = false;
    b.addEventListener("message", () => { leaked = true; });
    a.send("segredo-do-room-1");
    await new Promise((r) => setTimeout(r, 50));
    expect(leaked).toBe(false);
  });
});
