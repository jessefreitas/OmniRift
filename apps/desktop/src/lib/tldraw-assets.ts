// src/lib/tldraw-assets.ts
//
// URLs dos assets do tldraw (ícones/fontes/traduções) apontando pro /public local
// (apps/desktop/public/tldraw-assets/*), servido pelo Vite sem rede. Sem isso o
// tldraw busca no CDN e a toolbar fica sem ícones no WebKitGTK (TLS quebrado).
// Usa o helper `selfHosted` (só monta strings — sem imports ?url frágeis do rolldown).

import { getAssetUrls } from "@tldraw/assets/selfHosted";

export const TLDRAW_ASSET_URLS = getAssetUrls({ baseUrl: "/tldraw-assets" });
