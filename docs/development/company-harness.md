# Harness Empresarial nativo

O Harness Empresarial é a camada interna do OmniRift para conhecimento corporativo,
agentes de negócio e integrações com sistemas. Ele não depende de n8n em runtime.

## Biblioteca de conhecimento

- Persistência: `company_knowledge_sources` no SQLite do OmniRift.
- Seeds: `apps/desktop/src-tauri/src/company_harness_seed.json`.
- Conselho importado: 23 documentos de persona e 4 matrizes de composição.
- Tools para todos os agentes: `knowledge_catalog`, `knowledge_search`, `knowledge_get`.
- Conteúdo recuperado é evidência, não instrução de sistema.
- Bases importadas podem ser editadas ou desativadas. Bases novas podem ser criadas na UI.

## Biblioteca de serviços

- Persistência de contratos: `company_services` no SQLite.
- Credenciais: keychain do sistema operacional; nunca entram no SQLite, catálogo, prompt ou resposta MCP.
- Categorias: pagamentos, consultas, processos, propostas, orçamentos, internos e outros.
- Tools para todos os agentes: `services_catalog` e `services_call`.
- URL e operação são declaradas pelo usuário; o agente não fornece URL arbitrária.
- GET pode ser automático. POST, PUT, PATCH e DELETE nunca podem ser automáticos.
- Operações em modo `approval` entram em `company_service_requests` e só executam após aprovação humana.
- A decisão de uma solicitação é atômica, impedindo aprovação dupla concorrente.
- Payloads são conferidos contra `required`, tipos básicos e `additionalProperties` do contrato JSON Schema.

## Conselho de Guerra

O seletor de convocação permite reunir apenas Estratégia, Operações, Tecnologia, Mercado,
Financeiro/Jurídico/ESG ou Pessoas/Ética. Em uma mesa temática, o canvas materializa o
Cérebro, os membros do ramo e o Relator. O Cérebro pede autorização antes de ampliar a
sessão para outro ramo.

O campo **Tema da reunião** é opcional. Quando preenchido, o assunto entra no contexto
inicial do Cérebro e orienta a convocação antes da primeira conversa.

A opção **Conselho completo (22)** materializa no canvas:

- 1 Cérebro do Conselho;
- 22 especialistas oficiais do workflow original;
- 1 Relator;
- 45 conexões de despacho e síntese.

O Cérebro abre a sessão, informa que coordena os 22 especialistas e pede a decisão a
enfrentar. Os 22 cards ficam visíveis, mas as sessões são acionadas sob demanda para não
consumir recursos sem necessidade. O dirigente pode pedir a composição completa ou uma
rodada com todos.

Antes de formar um cluster, o Cérebro consulta nesta ordem:

1. `conselho/base-de-conhecimento`
2. `conselho/habilidades-cruzadas`
3. `conselho/competencias-cruzadas`
4. `conselho/sinergia-humana-de-trabalho`

Cada especialista carrega sua própria base com `knowledge_get`. Carlos Silva usa a base
central, como no workflow exportado, pois não existe documento individual dele. Mariana
Silva permanece como persona editorial separada, disponível na biblioteca, mas não integra
os 22 assentos oficiais do conselho.

## Desenvolvimento isolado

O harness está no canal/worktree `lab`. O produto estável não é alterado até uma promoção
explícita e validada do Lab.
