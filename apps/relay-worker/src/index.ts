// src/index.ts
import { RoomDO, type Env } from "./room";
export { RoomDO };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/r\/([A-Za-z0-9_-]{8,128})$/);
    if (!m) return new Response("not found", { status: 404 });
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const id = env.ROOMS.idFromName(m[1]); // room = deviceToken
    return env.ROOMS.get(id).fetch(req);
  },
};
