# Licenciamento forte (entitlement server-authoritative) — Design

**Goal:** community (grátis, público) roda LIMITADO; licença DESBLOQUEIA ilimitado; proteção forte contra pirataria — autoridade no servidor, não no cliente.

**Princípio:** o cliente não tem "boolean de licenciado" pra virar. Quem decide é o **servidor**, que emite um **entitlement assinado (Ed25519, exp curto)** vinculado ao dispositivo. Patchear o binário é o único ataque (sempre é), mas **seat cap + revogação + device-binding + features pro fora do source público** tornam pirataria cara e **revogável**.

## Tiers

| | Community (grátis, público) | Full (licenciado) |
|---|---|---|
| Canvas (projetos) | **1** | ilimitado |
| Agentes (terminais) | **5** | ilimitado |
| Paralelos (floors) | **1** | ilimitado |

Limite `0` = ilimitado. Community é o **default sem token**. Dev build (debug) = full.

## Entitlement (token assinado pelo servidor)

```
payload.sig   (base64url Ed25519, como o license.rs atual)
payload = { lid, fp, tier:"full", lim:{canvas:0,agents:0,floors:0}, iat, exp }
```
- `fp` = fingerprint da máquina (binding). `exp` curto (ex. 7–30d) → exige refresh.
- Cliente verifica: assinatura ✓ (pubkey embutida) + `fp` casa + não expirou → aplica `lim`.

## Componentes / Fases

- **F1 — Cliente/gate (repo OmniRift):** evolui `license.rs` → tier+limits; `license_status` devolve limites efetivos (community default ou do entitlement). Enforce nos 3 pontos do `canvas-store` (`addProject`/`createFloor`/`addTerminal`) → bloqueia + sinaliza "upgrade". UI Licença/Upgrade (tier, fingerprint copiável, colar chave, limites). Tests.
- **F2 — License server (scaffold; deploy na infra própria do OmniRift):** axum + Postgres. `/activate` (key+device → checa seat cap, registra device, assina entitlement) · `/refresh` · `/revoke`. Chave privada de assinatura **só no servidor**. Seat cap = **3 dispositivos/licença**. Device keypair (prova de posse) entra aqui.
- **F3 — Emissão:** webhook Asaas/Stripe → mint da key na compra (entrega por email).
- **F4 — Hardening:** ofuscação, checagem de integridade do binário, rotação de chave, refresh-loop com grace offline.

## Distribuição (open-core)
Full = binário assinado distribuído; **source completo só no Forgejo**. GitHub OmniRift = réplica **community** (sem o código pro). Ver `project_forgejo-source-github-publish`.

## Caveat honesto
Gate client-side é sempre patchável; a força real vem de F2/F4 (servidor + seat cap + revogação + refresh). F1 sozinho = fundação, não a proteção final.
