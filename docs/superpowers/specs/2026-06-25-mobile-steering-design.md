# Mobile steering opt-in — Design

> Status: active · 2026-06-25. Complementa o #9 (relay) + #8-fase2 (RPC mutations). Branch
> feat/mobile-steering. SÓ lado desktop (o cliente RN é outra sessão — não tocar o app RN).

**Goal:** permitir que um celular pareado **controle** agentes pelo relay E2EE (não só monitore) —
chamar `agent.spawn/send/kill`. Hoje o mobile é read-only (allowlist). O steering é uma **capability
POR-DISPOSITIVO, default OFF, concedida explicitamente no desktop** (o celular NUNCA se auto-concede).

## Modelo de segurança (central)
- **Default OFF**: device pareado nasce read-only (monitor + push). Só vê status/agents/snapshot.
- **Grant explícito no desktop**: o usuário liga "permitir controle" pra um device específico na UI de
  Conexões/Dispositivos. Grava `steer: true` no `DeviceEntry` (devices.json 0600).
- **Steering destrava SÓ as mutações de agente** (`agent.spawn/send/kill`), via um allowlist separado
  `MOBILE_STEER_ALLOWLIST` — NÃO abre o registro inteiro.
- Revogável: desligar o toggle (ou remover o device) corta o controle na hora.
- Migração: entradas antigas sem `steer` → serde default `false` (read-only — seguro).

## Backend (rpc/ — aditivo)
1. **devices.rs**: `DeviceEntry` ganha `#[serde(default)] steer: bool`. `set_steer(device_id, bool)` (persiste).
2. **allowlist.rs**: `MOBILE_STEER_ALLOWLIST = ["agent.spawn","agent.send","agent.kill"]`. Gate:
   `is_allowed(method, scope) || (steer && MOBILE_STEER_ALLOWLIST.contains(method))` — sem quebrar a
   assinatura atual (helper `is_steer_allowed(method)` + o ws compõe). Read-only segue sempre liberado.
3. **ws.rs**: após o auth E2EE, pega o `steer` do device e passa pro gate antes do dispatch. Method fora
   de tudo → `forbidden`.
4. **comandos Tauri**: `mobile_set_steering(deviceId, enabled)` + `mobile_devices_list` retorna `steer`.

## Frontend (mínimo — Área de Conexões/Dispositivos)
Toggle "Permitir controle" por device (chama `mobile_set_steering`), com aviso de que o celular poderá
spawnar/matar agentes. Default desligado. (Se a UI de devices não existir ainda, expõe via a Área de
Conexões existente; senão, fica só o comando + a fase de UI é follow.)

## Decisões
1. Per-device, não global (cada celular decide-se). 2. Default OFF (opt-in). 3. Steering = só as 3
   mutações de agente (allowlist separado), não o registro todo. 4. Grant só no desktop (anti-escalação).
   5. NÃO tocar o cliente RN (outra sessão). 6. Confirmação por-ação no desktop = fase futura (o grant
   por-device já é a barreira; um "device X quer spawnar?" pop-up pode vir depois).

## Testing
- cargo (não regride): device default `steer:false`; `set_steer` persiste + relê (0600); gate —
  Mobile sem steer → write `forbidden`; Mobile com steer → spawn/send/kill OK MAS um método não-mutação
  fora da allowlist segue forbidden (steering não abre tudo); Runtime intacto; migração (json sem steer →
  false). tsc se tocar o front. GLM 5.2 audita (foco: escalação, default-off, o celular não se auto-concede).
