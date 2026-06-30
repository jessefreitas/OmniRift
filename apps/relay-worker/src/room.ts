// src/room.ts
import { DurableObject } from "cloudflare:workers";

export interface Env { ROOMS: DurableObjectNamespace }

/** Um room = um par desktop↔celular. Segura ≤2 sockets e repassa frames opacos
 *  entre eles. WebSocket Hibernation: os sockets vivem em ctx, não na memória. */
export class RoomDO extends DurableObject {
  async fetch(_req: Request): Promise<Response> {
    if ((this.ctx.getWebSockets()?.length ?? 0) >= 2) {
      return new Response("room cheio", { status: 409 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server); // hibernation-aware
    return new Response(null, { status: 101, webSocket: client });
  }

  // Hibernation handler: chamado quando chega mensagem em qualquer socket do room.
  webSocketMessage(sender: WebSocket, message: string | ArrayBuffer) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== sender) {
        try { ws.send(message); } catch { /* peer foi embora */ }
      }
    }
  }

  webSocketClose(ws: WebSocket) {
    try { ws.close(); } catch { /* noop */ }
  }
}
