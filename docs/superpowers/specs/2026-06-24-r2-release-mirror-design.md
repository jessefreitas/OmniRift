# Espelho de Releases no R2 (download via CDN, egress zero) — Design

> Status: **active** · 2026-06-24. Contribuição proposta por colaborador + aprovada pelo Jesse.
> Mantém o GitHub Release como **source of truth** e espelha os instaladores pro **Cloudflare R2**,
> servindo o `/download` via CDN (egress zero, sem rate limit do GitHub API).

**Goal:** Mesmo fluxo de hoje (CI builda Win+Linux → frontend "baixar → escolhe SO"), mas os
instaladores passam a ser servidos do **R2** em vez de redirecionar pro GitHub. GitHub Release
continua existindo (alimenta o **Tauri updater** nativo) — abordagem **HÍBRIDA**.

**Por que híbrido (não R2-only):** o updater do Tauri já lê `latest.json`/`.sig` do GitHub Release
nativamente. Manter o Release = updater intocado + R2 só pro download web. Menos risco, ganho real
(egress zero + CDN + sem rate limit que hoje mitigamos com cache de 15min).

---

## Arquitetura (o que muda vs. hoje)
```
push tag v* → GH Actions:
  guard → build (win+linux, assina minisign) → tauri-action cria GitHub Release (assets)  [INTOCADO]
                                              → NOVO job "mirror": sobe os assets pro R2 (bucket omnirift-releases/<tag>/ + /latest/)
landing (detecta SO) → worker /download/<so> → 302 → R2 (CDN)   [MUDA: hoje vai pro GitHub]
                                              ↳ fallback GitHub se o asset não estiver no R2
app instalado → updater lê latest.json/.sig do GitHub Release   [INTOCADO]
```

## Componentes / pontos de edição
1. **`.github/workflows/release.yml`** — novo job `mirror` (needs: build), roda DEPOIS do tauri-action:
   - baixa os assets do Release recém-criado (gh release download) OU reusa os artefatos do build;
   - `aws s3 cp`/`rclone`/`wrangler r2 object put` → sobe pra `r2://omnirift-releases/releases/<tag>/<arquivo>`
     **e** copia pra `releases/latest/<arquivo>` (ponteiro estável). Sobe os 4 instaladores (+ opcional latest.json/.sig).
   - Secrets novos: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`, `R2_BUCKET` (S3-compat do R2).
2. **`services/license-worker/wrangler.toml`** — adicionar binding R2:
   `[[r2_buckets]] binding = "RELEASES"  bucket_name = "omnirift-releases"`.
3. **`services/license-worker/src/index.ts`** (`/download/:platform?`) — resolver pelo R2:
   - tenta servir/redirecionar do R2 (binding `env.RELEASES.get("releases/latest/<arquivo-do-so>")` →
     stream, OU 302 pro domínio público `https://dl.omnirift.omniforge.com.br/releases/latest/<arquivo>`);
   - **fallback** pro fluxo atual (GitHub API latest) se o objeto não existir no R2. Mantém o cache.
   - Mantém a detecção de SO por path/UA igual.
4. **Domínio** (opcional, recomendado): custom domain do bucket `dl.omnirift.omniforge.com.br` (R2 público)
   — aí o worker só faz 302 (sem stream pelo Worker, mais barato). Alternativa: servir via binding (privado).

## Pré-requisitos de infra (provisionar 1x)
- [ ] Criar bucket R2 **`omnirift-releases`** (conta CF `0245b00ef3744d9e0e07f785971bb90a`).
- [ ] (Opcional) custom domain `dl.omnirift.omniforge.com.br` → bucket (acesso público read-only).
- [ ] Criar **R2 API token** (S3-compat: access key + secret) com escopo de Object Read/Write nesse bucket.
- [ ] Adicionar como **GitHub Actions secrets** (R2_ACCESS_KEY_ID/SECRET/ACCOUNT_ID/BUCKET).
- [ ] Salvar as credenciais no **cofre OmniMemory** + registrar em `docs/registry/` (organização — pedido do Jesse).

## Error handling / segurança
- `/download` **fail-open**: R2 indisponível/objeto ausente → cai no GitHub (nunca quebra o download).
- Bucket é **read público só pros instaladores** (sem listar); upload só via token de CI (write).
- Credencial R2 nunca em código/log — só GH secret + cofre.
- Idempotente: re-subir a mesma tag sobrescreve (ok) — `latest/` sempre aponta pro mais novo.

## Migração / rollback
- Liga gradual: o worker tenta R2, cai no GitHub → zero downtime. Reverter = remover o job mirror +
  voltar o `/download` (1 commit). GitHub Release nunca deixou de ser a fonte.

## Decisões
1. **Híbrido** (GitHub source + R2 CDN), updater fica no GitHub por ora. 2. Bucket `omnirift-releases`,
chaves `releases/<tag>/` + `releases/latest/`. 3. `/download` com **fallback GitHub** (fail-open).
4. Credenciais no cofre + `docs/registry/` (organizado no gitmemory).

## Em aberto (decidir antes de implementar)
- Servir via **custom domain público** (302 mais barato) **vs binding R2 no Worker** (privado, stream).
- Espelhar `latest.json`/`.sig` pro R2 também (preparar updater R2-only no futuro) ou só os instaladores.
- Quem provisiona o R2 (bucket+token): via CF API (se houver token cfat_ no cofre) ou Jesse no dashboard.
