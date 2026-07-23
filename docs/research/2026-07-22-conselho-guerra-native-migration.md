# Migração nativa — Conselho de Guerra

Fonte auditada: `/home/skycracker/Downloads/Conselho de Guerra.json`.

## Inventário do export

- 46 nós totais;
- 43 habilitados;
- 3 nós antigos de EcoTech desabilitados;
- 27 Google Docs usados como tools;
- 1 agente LangChain com um modelo OpenAI;
- 1 guardrail, 1 switch, 2 transformações de campos e 2 blocos JavaScript;
- 2 webhooks ativos para página/chat e seus response nodes;
- 1 Postgres isolado com operação destrutiva `deleteTable`;
- Wikipedia e Gmail presentes com conexões vazias, portanto sem participação no fluxo ativo.

## Equivalência n8n → OmniRift

| Comportamento no export | Equivalente nativo |
|---|---|
| Webhook GET + HTML de chat | Canvas e AgentNodes do OmniRift |
| Webhook POST `/chat` | Conversa nativa do agente no canvas |
| `action=convocar_conselho` | Botão **Reunir Conselho** |
| `action=chat` + modo `single` | Conversa direta com a persona escolhida |
| modo `conselho` | Cérebro roteia para cluster e Relator sintetiza |
| JavaScript de prompt/histórico | Prompt de papel + histórico nativo do AgentNode |
| AI Agent único | 22 especialistas vivos no canvas + Cérebro + Relator |
| Google Docs tools | 27 bases copiadas para SQLite/seed interno |
| Ordem das 4 matrizes | Protocolo explícito do Cérebro do Conselho |
| OpenAI Chat Model | Runtime/CLI escolhido por agente no OmniRift |
| Guardrails de escopo e qualidade | Contrato empresarial dos papéis e validações do harness |
| Resposta JSON do webhook | Mensagens e conexões internas do canvas |
| Gmail desconectado | Futuro serviço de e-mail, com aprovação humana |
| Postgres `deleteTable` desconectado | Não migrado: não participava do fluxo e era destrutivo |
| UI EcoTech desabilitada | Não migrada: código morto no export |

## Diferenças deliberadas

- O OmniRift deixa claro que cada membro é uma persona assistida; não preserva a instrução
  enganosa do export para negar que exista IA.
- Nenhuma credencial veio no JSON ou nas bases. Segredos devem ser cadastrados no keychain.
- O uso normal não chama n8n nem Google Drive. Os documentos foram lidos uma vez para migração.
- Wikipedia e Gmail só serão habilitados quando forem declarados na Biblioteca de Serviços;
  mutações e envios devem passar por aprovação humana.

## Critério para considerar a cópia completa

A lógica ativa, as 27 bases, os 22 assentos oficiais, o roteamento individual/conselho e a
síntese executiva têm equivalentes internos. O que não foi copiado é código morto,
desconectado ou uma operação destrutiva sem participação no workflow.
