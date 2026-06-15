// src/lib/api-client.ts
//
// Cliente HTTP do API node — chama o command Rust (reqwest), que roda fora do
// WebKitGTK (sem o TLS quebrado da webview) e em qualquer site.

import { invoke } from "@tauri-apps/api/core";

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  durationMs: number;
}

export async function httpRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
): Promise<HttpResponse> {
  return invoke<HttpResponse>("http_request", { method, url, headers, body: body ?? null });
}
