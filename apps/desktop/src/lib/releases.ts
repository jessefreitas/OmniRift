// src/lib/releases.ts
//
// Central de Releases — histórico COMPLETO de versões do OmniRift (v0.1.0 → v0.1.89),
// SEM pular nenhuma. Fonte: tags de release do produto. Os `highlights` são a tradução
// dos assuntos técnicos de cada versão para linguagem que o usuário final entende
// (evita jargão de commit). Consumido pelo ReleaseNotesModal (dado estático, sem I/O).
//
// ⚠️ Requisito do dono: "não quero que pule nem uma desde o início" — este array TEM
// que ter exatamente 77 entradas, uma por versão publicada. Ordem: MAIS RECENTE PRIMEIRO.

export interface ReleaseEntry {
  /** Versão sem o "v" — ex.: "0.1.89". */
  version: string;
  /** Data de release em ISO — ex.: "2026-07-03". */
  date: string;
  /** Título curto e legível do tema da versão. */
  title: string;
  /** 1–4 bullets legíveis por leigo (pt-BR), derivados do assunto da versão. */
  highlights: string[];
  /** Classificação pelo tipo predominante da versão. */
  tag?: "feature" | "fix" | "infra";
}

/** Histórico completo — 77 versões, da mais nova (0.1.89) para a mais antiga (0.1.0). */
export const RELEASES: ReleaseEntry[] = [
  {
    version: "0.1.104",
    date: "2026-07-04",
    title: "Sprints no Kanban + explicação do Terminal-Bench",
    highlights: [
      "Metodologia de Sprints: organize os cards em janelas (Todos · Backlog · sprints, o ativo com 👑)",
      "Crie/ative sprints e mova cards pro sprint ativo direto no painel do Kanban",
      "Terminal-Bench agora explica como funciona e o que fazer pra rodar",
    ],
    tag: "feature",
  },
  {
    version: "0.1.103",
    date: "2026-07-04",
    title: "Time com chefe: o Arquiteto orquestra + deletar agente suspenso",
    highlights: [
      "Ao montar um time no Pipeline, o Arquiteto vira o Orquestrador (👑) e comanda o resto",
      "Botão X pra deletar o agente suspenso (💤) sem precisar acordá-lo",
      "Painel de Novidades completo — todas as versões até agora",
    ],
    tag: "feature",
  },
  {
    version: "0.1.102",
    date: "2026-07-04",
    title: "Fim da tela preta + Delete apaga o agente + debug que grava tudo",
    highlights: [
      "Corrige a tela preta ao ativar/deletar um agente (era o renderer de GPU do terminal)",
      "Tecla Delete apaga o agente selecionado; botão X no card do agente suspenso (💤)",
      "Debug nativo: erros e travamentos vão pro ~/.omnirift/debug.log automaticamente",
    ],
    tag: "fix",
  },
  {
    version: "0.1.101",
    date: "2026-07-03",
    title: "Central de Configurações (Settings + Conta)",
    highlights: [
      "Toda a configuração num lugar só, com abas (Conta, Geral, Privacidade e atalhos)",
      "Aba Conta: sua licença, ID da máquina e planos num painel só",
      "Privacidade em destaque: o OmniRift roda 100% local, zero telemetria",
    ],
    tag: "feature",
  },
  {
    version: "0.1.100",
    date: "2026-07-03",
    title: "Terminal-Bench (selo do agente) + scan de credencial (Lurkr)",
    highlights: [
      "Roda uma suíte de tarefas num agente e mede quantas ele resolve — um número objetivo",
      "Lurkr avisa quando uma credencial iria pro LLM no contexto (redigida, nunca crua)",
    ],
    tag: "feature",
  },
  {
    version: "0.1.99",
    date: "2026-07-03",
    title: "Recitação de foco: o agente não perde o rumo em loop longo",
    highlights: [
      "Em tarefas longas, o agente relembra o objetivo + seu card do Kanban (técnica do Manus)",
      "Toggle 📿 por-agente pra ligar ou desligar",
    ],
    tag: "feature",
  },
  {
    version: "0.1.98",
    date: "2026-07-03",
    title: "Saúde do agente nos Insights",
    highlights: [
      "Cada agente ganha um status de saúde (verde/amarelo/vermelho)",
      "Detecta erro alto, lentidão travada e gasto acima da média do time",
    ],
    tag: "feature",
  },
  {
    version: "0.1.97",
    date: "2026-07-03",
    title: "App ~11 MB mais leve (editor de código enxuto)",
    highlights: [
      "Remove peso morto do editor — a instalação fica bem menor",
    ],
    tag: "infra",
  },
  {
    version: "0.1.96",
    date: "2026-07-03",
    title: "Canvas mais fluido",
    highlights: [
      "Menos trabalho repetido ao monitorar os processos dos agentes",
      "Os nós redesenham menos à toa",
      "Autosave a cada 5 min em vez de a cada tecla digitada",
    ],
    tag: "fix",
  },
  {
    version: "0.1.95",
    date: "2026-07-03",
    title: "Correção da tela preta (loop do nó de Filtro)",
    highlights: [
      "O nó de Filtro entrava em loop de desenho e escurecia a tela — corrigido",
    ],
    tag: "fix",
  },
  {
    version: "0.1.94",
    date: "2026-07-03",
    title: "Abrir projeto não trava: agentes voltam suspensos",
    highlights: [
      "Ao reabrir um projeto, os agentes voltam suspensos (💤) em vez de subir todos de uma vez",
      "Clique pra acordar só os que você vai usar — fim do travamento com muitos agentes",
    ],
    tag: "fix",
  },
  {
    version: "0.1.93",
    date: "2026-07-03",
    title: "Mapa do código sob demanda + busca do drive mais rápida",
    highlights: [
      "O grafo do código só é gerado quando você pede — não trava a abertura do projeto",
      "O drive dos agentes (OmniFS) reindexa só o que mudou (bem mais rápido)",
    ],
    tag: "fix",
  },
  {
    version: "0.1.92",
    date: "2026-07-03",
    title: "Abrir repositório não trava mais",
    highlights: [
      "A varredura do código roda em prioridade baixa — não engasga a máquina",
    ],
    tag: "fix",
  },
  {
    version: "0.1.91",
    date: "2026-07-03",
    title: "Nó de Filtro maior e redimensionável",
    highlights: [
      "O modo IA do Filtro cabia mal — agora o nó nasce maior e você pode redimensionar",
    ],
    tag: "fix",
  },
  {
    version: "0.1.90",
    date: "2026-07-03",
    title: "Central de Releases + Manual + OmniGraph robusto",
    highlights: [
      "Este painel de Novidades + um Manual rico dentro do app",
      "O Mapa do código (OmniGraph) aguenta repositórios grandes sem travar",
      "Novas feature flags: checkpoint automático, busca semântica e grafo no canvas",
    ],
    tag: "feature",
  },
  {
    version: "0.1.89",
    date: "2026-07-03",
    title: "OmniFS mais resistente a travamentos",
    highlights: [
      "Evita o congelamento do drive dos agentes quando o disco enche",
      "Detecta quando a pasta para de responder (mount travado)",
      "Botão Reconectar religa o drive sem precisar reiniciar o app",
    ],
    tag: "fix",
  },
  {
    version: "0.1.88",
    date: "2026-07-03",
    title: "OmniFS: desfazer por ação e busca por significado",
    highlights: [
      "Cada turno do agente vira um ponto de restauração automático",
      "Desfaça uma ação direto no nó do agente (rollback)",
      "Busca semântica dos arquivos direto na interface",
    ],
    tag: "feature",
  },
  {
    version: "0.1.87",
    date: "2026-07-03",
    title: "Feature flags, Insights v2 e OmniFS no macOS",
    highlights: [
      "Liga e desliga recursos por máquina (feature flags)",
      "Insights com métricas de latência e erros dos agentes",
      "OmniFS agora funciona também no macOS",
    ],
    tag: "feature",
  },
  {
    version: "0.1.86",
    date: "2026-07-03",
    title: "OmniFS embutido, subagentes dinâmicos e Insights",
    highlights: [
      "OmniFS já vem incluído no app — sem instalar à parte",
      "Agentes criam subagentes dinamicamente conforme a tarefa",
      "Painel de Insights de uso e scanner de código",
    ],
    tag: "feature",
  },
  {
    version: "0.1.85",
    date: "2026-07-02",
    title: "Agentes seguros por padrão",
    highlights: [
      "Agentes nascem com boas práticas de segurança e tratamento de erros",
      "Revisão de código com aprovação (GO/NO-GO) antes de encerrar",
    ],
    tag: "feature",
  },
  {
    version: "0.1.83",
    date: "2026-07-02",
    title: "Controle pelo celular mais estável",
    highlights: [
      "O controle remoto pelo celular continua funcionando mesmo depois de reparear o dispositivo",
    ],
    tag: "fix",
  },
  {
    version: "0.1.82",
    date: "2026-07-02",
    title: "Controle remoto pelo celular completo",
    highlights: [
      "Aprove ou negue as permissões dos agentes pelo celular",
      "Mova os cards do Kanban direto do celular",
    ],
    tag: "feature",
  },
  {
    version: "0.1.81",
    date: "2026-07-02",
    title: "Grafo integrado, memória no keychain e mais",
    highlights: [
      "Grafo de conhecimento do código integrado à interface",
      "Onboarding automático ao abrir um repositório",
      "Tokens de conexão guardados com segurança no keychain do sistema",
      "Snapshots em cápsula e notas de versão geradas automaticamente",
    ],
    tag: "feature",
  },
  {
    version: "0.1.80",
    date: "2026-07-02",
    title: "Ligar todos os agentes ao canal de memória de uma vez",
    highlights: [
      "Conecte todos os agentes ao canal compartilhado sem refazer o planejamento do Arquiteto",
    ],
    tag: "feature",
  },
  {
    version: "0.1.79",
    date: "2026-07-02",
    title: "OmniGraph com múltiplas visões e comparação",
    highlights: [
      "Grafo do código com várias visões e comparação (diff) entre elas",
      "Corrige a exclusão de itens que não funcionava",
      "O time do pipeline aparece no canal de memória compartilhado",
    ],
    tag: "feature",
  },
  {
    version: "0.1.78",
    date: "2026-07-02",
    title: "OmniGraph — grafo de conhecimento do código",
    highlights: [
      "Novo grafo que mapeia a estrutura do seu código",
      "O Arquiteto usa o grafo para planejar com mais precisão",
      "O grafo se mantém limpo automaticamente (loop de aprendizado)",
    ],
    tag: "feature",
  },
  {
    version: "0.1.77",
    date: "2026-07-02",
    title: "OmniFS F3 e modo Aprender",
    highlights: [
      "Modo Aprender: um tutor que ensina a programar em várias linguagens",
      "Proteção anti-vazamento de solução no modo Aprender",
      "Avanços no OmniFS, o drive versionado dos agentes",
    ],
    tag: "feature",
  },
  {
    version: "0.1.72",
    date: "2026-07-02",
    title: "Design de sessões gerenciadas pelo backend",
    highlights: [
      "Documento de arquitetura: sessões de agente controladas pelo backend, com o nó virando só uma janela de visualização",
    ],
    tag: "infra",
  },
  {
    version: "0.1.71",
    date: "2026-07-01",
    title: "Barra de frota, Kanban customizável e custo honesto",
    highlights: [
      "Barra da frota mostrando todos os agentes de uma vez",
      "Kanban personalizável",
      "Colocar agentes para dormir e acordá-los depois (sleep/wake)",
      "Cálculo de custo mais honesto",
    ],
    tag: "feature",
  },
  {
    version: "0.1.69",
    date: "2026-07-01",
    title: "Release 0.1.69",
    highlights: [
      "Versão de consolidação, com a lista de pendências atualizada",
    ],
    tag: "infra",
  },
  {
    version: "0.1.68",
    date: "2026-07-01",
    title: "Subagentes não ficam órfãos ao reabrir o projeto",
    highlights: [
      "Ao reabrir um projeto, cada subagente volta ligado ao seu agente pai corretamente",
    ],
    tag: "fix",
  },
  {
    version: "0.1.67",
    date: "2026-07-01",
    title: "Recuperação de agente ao retomar a sessão",
    highlights: [
      "Quando a retomada de uma sessão falha, o app abre uma sessão nova em vez de encerrar o agente",
    ],
    tag: "fix",
  },
  {
    version: "0.1.66",
    date: "2026-07-01",
    title: "Arquiteto de Pipeline: montar o time completo",
    highlights: [
      "O botão Montar cria tudo de uma vez: briefing compartilhado, subagentes e acompanhamento do andamento",
    ],
    tag: "feature",
  },
  {
    version: "0.1.65",
    date: "2026-07-01",
    title: "Barra de rolagem visível e terminal animado",
    highlights: [
      "Barra de rolagem agora sempre visível",
      "As linhas do terminal animam conforme a atividade do agente",
    ],
    tag: "feature",
  },
  {
    version: "0.1.64",
    date: "2026-07-01",
    title: "Trocar de modelo sem perder a persona",
    highlights: [
      "Troque o modelo do agente sem perder o papel/persona que ele já tinha",
      "Duplo-clique no nó abre em tela cheia",
    ],
    tag: "feature",
  },
  {
    version: "0.1.63",
    date: "2026-07-01",
    title: "Arquiteto de Pipeline",
    highlights: [
      "Descreva o projeto e um LLM monta o time de agentes — com conexões, subagentes e paralelos — direto no canvas",
    ],
    tag: "feature",
  },
  {
    version: "0.1.62",
    date: "2026-07-01",
    title: "Copiar do terminal para a área de transferência",
    highlights: [
      "Copie texto do terminal direto para a área de transferência do sistema",
    ],
    tag: "feature",
  },
  {
    version: "0.1.61",
    date: "2026-07-01",
    title: "Conexões entre agentes mais fáceis",
    highlights: [
      "Ficou mais fácil ligar um agente ao outro — pontos de conexão maiores e área de captura ampliada",
    ],
    tag: "feature",
  },
  {
    version: "0.1.60",
    date: "2026-07-01",
    title: "Excluir conexão com um clique",
    highlights: [
      "Apague a linha de conexão entre dois agentes clicando no x",
    ],
    tag: "feature",
  },
  {
    version: "0.1.59",
    date: "2026-07-01",
    title: "Colar (Ctrl+V) no campo do OmniAgent",
    highlights: [
      "Cole conteúdo com Ctrl+V direto no campo de mensagem do OmniAgent",
    ],
    tag: "feature",
  },
  {
    version: "0.1.58",
    date: "2026-07-01",
    title: "Escolher o modelo do Claude e por subagente",
    highlights: [
      "Seletor de modelo do Claude",
      "Defina um modelo diferente para cada subagente",
    ],
    tag: "feature",
  },
  {
    version: "0.1.57",
    date: "2026-07-01",
    title: "Canvas por pasta e correção do menu de conexão",
    highlights: [
      "Cada pasta tem seu próprio canvas — os agentes voltam ao reabrir o projeto",
      "Corrige o menu de conexão entre agentes",
    ],
    tag: "feature",
  },
  {
    version: "0.1.56",
    date: "2026-07-01",
    title: "Busca nas skills do agente",
    highlights: [
      "Campo de busca para encontrar rapidamente as skills de um agente",
    ],
    tag: "feature",
  },
  {
    version: "0.1.55",
    date: "2026-07-01",
    title: "Goal mais robusto e filtro por IA",
    highlights: [
      "Modo Goal (repete até atingir a meta) ficou mais confiável",
      "Filtro por IA com explicações do porquê de cada item",
    ],
    tag: "feature",
  },
  {
    version: "0.1.54",
    date: "2026-07-01",
    title: "Correção de duplicatas na Central de Providers",
    highlights: [
      "Remove providers de LLM repetidos que apareciam na Central de Providers",
    ],
    tag: "fix",
  },
  {
    version: "0.1.53",
    date: "2026-07-01",
    title: "Central de API — gerencie todas as chaves",
    highlights: [
      "Nova tela para gerenciar todas as chaves de API dos providers de LLM num lugar só",
    ],
    tag: "feature",
  },
  {
    version: "0.1.52",
    date: "2026-07-01",
    title: "OmniPartner e review usam a Central de Providers",
    highlights: [
      "O OmniPartner (IA) e o code review passam a usar as chaves cadastradas na Central de Providers",
    ],
    tag: "feature",
  },
  {
    version: "0.1.51",
    date: "2026-07-01",
    title: "Central de Providers de LLM",
    highlights: [
      "Cadastre a chave do LLM uma vez e depois só selecione provider e modelo",
      "Recursos de Goal e Loop nos nós dos agentes",
    ],
    tag: "feature",
  },
  {
    version: "0.1.50",
    date: "2026-07-01",
    title: "Goal e Loop no nó do agente",
    highlights: [
      "Meta (Goal) que repete até atingir a condição, e Loop por tempo, direto no nó",
      "Correções no Hermes e no redimensionamento",
    ],
    tag: "feature",
  },
  {
    version: "0.1.48",
    date: "2026-07-01",
    title: "Wizard Hermes, ACP e conexões semânticas",
    highlights: [
      "Assistente para configurar o Hermes com a sua própria chave (BYOK)",
      "Camada ACP — os agentes viram objetos estruturados",
      "Conexões semânticas entre agentes",
    ],
    tag: "feature",
  },
  {
    version: "0.1.47",
    date: "2026-07-01",
    title: "ACP, conexões semânticas e Wizard Hermes",
    highlights: [
      "Nova camada ACP — os agentes deixam de ser terminais cegos e viram objetos estruturados",
      "Conexões semânticas entre agentes",
      "Assistente para configurar o Hermes com a sua própria chave (BYOK)",
    ],
    tag: "feature",
  },
  {
    version: "0.1.46",
    date: "2026-06-29",
    title: "Remoção do Gemini CLI e ajuste de nomes",
    highlights: [
      "Remove o Gemini CLI (o login pessoal foi descontinuado pelo Google)",
      "Renomeia 'Floor N' para 'Paralelo N'",
    ],
    tag: "fix",
  },
  {
    version: "0.1.45",
    date: "2026-06-29",
    title: "CLIs encontrados e celular lista todos os agentes",
    highlights: [
      "Corrige CLIs que não eram encontrados, como o gemini e ferramentas instaladas pelo nvm",
      "O celular passa a listar todos os agentes do canvas",
    ],
    tag: "fix",
  },
  {
    version: "0.1.44",
    date: "2026-06-29",
    title: "Cores no terminal e selos no cabeçalho do agente",
    highlights: [
      "Corrige as cores do terminal no app instalado",
      "Selos no cabeçalho do agente: ícone do CLI, tempo de sessão e uso de memória",
      "Enviar para vários agentes ao mesmo tempo ficou instantâneo",
    ],
    tag: "fix",
  },
  {
    version: "0.1.43",
    date: "2026-06-29",
    title: "Correções de entrada, auditoria de segurança e Skills em lista",
    highlights: [
      "Corrige a digitação do ç, colar imagem e o limite de 32 MB no campo de entrada",
      "Auditoria de segurança: corrige vazamento de processos e reforça proteções",
      "Central de Skills em formato de lista, com seleção múltipla por agente",
      "Renomeia 'floor' para 'paralelo'",
    ],
    tag: "fix",
  },
  {
    version: "0.1.42",
    date: "2026-06-28",
    title: "Canal de agentes, orçamento de contexto e Central de Skills",
    highlights: [
      "Canal de comunicação entre os agentes",
      "Correções de UX: teclado ç (ABNT2), terminal, voz em pt e pasta de trabalho",
      "Orçamento de contexto de MCP por papel de agente",
      "Central de Skills (globais e por agente)",
    ],
    tag: "feature",
  },
  {
    version: "0.1.41",
    date: "2026-06-27",
    title: "Correção de acentos duplicados",
    highlights: [
      "Corrige letras acentuadas que apareciam duplicadas ao digitar (ç, á, ã) no Linux",
    ],
    tag: "fix",
  },
  {
    version: "0.1.40",
    date: "2026-06-27",
    title: "Build para macOS Apple Silicon",
    highlights: [
      "Passa a gerar o instalador (.dmg) para Mac com chip Apple Silicon",
    ],
    tag: "infra",
  },
  {
    version: "0.1.39",
    date: "2026-06-27",
    title: "Boot limpo e links clicáveis no terminal",
    highlights: [
      "Início limpo, sem restaurar o projeto anterior automaticamente",
      "Renomeie abas e paralelos direto na interface",
      "Links viram clicáveis no terminal",
    ],
    tag: "feature",
  },
  {
    version: "0.1.38",
    date: "2026-06-26",
    title: "Routines fase 2 e Painel de Complexidade",
    highlights: [
      "Avanços nas Routines (tarefas agendadas)",
      "Novo Painel de Complexidade do código",
    ],
    tag: "feature",
  },
  {
    version: "0.1.37",
    date: "2026-06-25",
    title: "Routines (tarefas agendadas)",
    highlights: [
      "Primeira versão das Routines: tarefas recorrentes com histórico e um paralelo como alvo",
    ],
    tag: "feature",
  },
  {
    version: "0.1.36",
    date: "2026-06-25",
    title: "Controle por CLI, painel mobile e suporte a Windows",
    highlights: [
      "Controle os agentes pela linha de comando (CLI)",
      "Painel e controle (steering) pelo celular",
      "Suporte a named-pipe no Windows",
    ],
    tag: "feature",
  },
  {
    version: "0.1.35",
    date: "2026-06-25",
    title: "Grandes refatorações: backend do terminal, SSH e mobile",
    highlights: [
      "Terminal passa a ser gerenciado pelo backend",
      "Controle via RPC/CLI e execução em vários hosts por SSH",
      "Base para o controle remoto pelo celular",
      "Captura de elementos no Design Mode",
    ],
    tag: "feature",
  },
  {
    version: "0.1.34",
    date: "2026-06-25",
    title: "Barra lateral arrastável e dicas legíveis",
    highlights: [
      "Reorganize a barra lateral arrastando os itens",
      "Dicas (tooltips) mais legíveis",
    ],
    tag: "feature",
  },
  {
    version: "0.1.33",
    date: "2026-06-25",
    title: "Polimento geral e correções do TURBO",
    highlights: [
      "Melhorias em janelas de prompt, redimensionamento e importação",
      "Dados persistidos no banco de dados",
      "Correções no modo TURBO",
    ],
    tag: "fix",
  },
  {
    version: "0.1.32",
    date: "2026-06-24",
    title: "Barra lateral dividida, importar agente e modo TURBO",
    highlights: [
      "Barra lateral reorganizada em seções",
      "Importe um agente pronto",
      "Exporte para PDF e HTML",
      "Modo TURBO: loop autônomo com meta verificável",
    ],
    tag: "feature",
  },
  {
    version: "0.1.31",
    date: "2026-06-24",
    title: "Manual didático e grupo de WhatsApp",
    highlights: [
      "Manual interno mais didático",
      "Link para o grupo de dúvidas no WhatsApp",
    ],
    tag: "feature",
  },
  {
    version: "0.1.30",
    date: "2026-06-24",
    title: "Rolagem do canvas e barra lateral",
    highlights: [
      "Ajuste na rolagem do canvas (não rola sem querer sobre os nós)",
      "Melhorias na barra lateral",
    ],
    tag: "feature",
  },
  {
    version: "0.1.29",
    date: "2026-06-24",
    title: "Host de execução, censura de segredos e Design grab",
    highlights: [
      "Escolha o host onde os agentes rodam — local ou por SSH",
      "Censura automática de segredos que apareceriam na tela",
      "Captura de elementos no Design Mode",
    ],
    tag: "feature",
  },
  {
    version: "0.1.28",
    date: "2026-06-24",
    title: "Notificações de status e espelho no R2",
    highlights: [
      "Ganchos (push-hooks) que avisam sobre o status dos agentes",
      "Espelhamento dos downloads no Cloudflare R2",
    ],
    tag: "feature",
  },
  {
    version: "0.1.27",
    date: "2026-06-24",
    title: "Esteira de download no R2",
    highlights: [
      "Distribuição dos downloads do app via Cloudflare R2",
    ],
    tag: "infra",
  },
  {
    version: "0.1.26",
    date: "2026-06-24",
    title: "Relatório de IA persistente",
    highlights: [
      "O relatório gerado pela IA agora fica salvo entre as sessões",
    ],
    tag: "feature",
  },
  {
    version: "0.1.25",
    date: "2026-06-24",
    title: "Saúde do Projeto — banco de dados ao vivo",
    highlights: [
      "O painel de Saúde do Projeto passa a ler o banco de dados ao vivo",
    ],
    tag: "feature",
  },
  {
    version: "0.1.24",
    date: "2026-06-24",
    title: "Ações com backup automático",
    highlights: [
      "As correções aplicadas pela IA criam um backup antes de mexer no código",
    ],
    tag: "feature",
  },
  {
    version: "0.1.23",
    date: "2026-06-24",
    title: "Saúde do Projeto — Fase B",
    highlights: [
      "Mais recursos no painel de Saúde do Projeto",
      "Seção 'Entenda' explicando cada achado",
    ],
    tag: "feature",
  },
  {
    version: "0.1.22",
    date: "2026-06-24",
    title: "Painel de Saúde do Projeto",
    highlights: [
      "Novo painel que analisa a saúde do seu projeto",
    ],
    tag: "feature",
  },
  {
    version: "0.1.21",
    date: "2026-06-23",
    title: "Relatório de economia",
    highlights: [
      "Relatório de economia de tokens e custo gerado pelos agentes",
    ],
    tag: "feature",
  },
  {
    version: "0.1.20",
    date: "2026-06-23",
    title: "Coordenação de agentes (reservas)",
    highlights: [
      "Os agentes reservam arquivos (claims) para não editarem o mesmo trecho ao mesmo tempo",
    ],
    tag: "feature",
  },
  {
    version: "0.1.19",
    date: "2026-06-23",
    title: "Instalador encerra processos auxiliares",
    highlights: [
      "O instalador finaliza os processos auxiliares (sidecars) antes de atualizar",
    ],
    tag: "fix",
  },
  {
    version: "0.1.18",
    date: "2026-06-23",
    title: "Correção do terminal no Windows e Fase 9 completa",
    highlights: [
      "Corrige o terminal (PTY) no Windows",
      "Conclui a Fase 9 do produto",
    ],
    tag: "fix",
  },
  {
    version: "0.1.17",
    date: "2026-06-23",
    title: "Agente Depurador (DebuggerAgent)",
    highlights: [
      "Novo agente especializado em depurar código",
    ],
    tag: "feature",
  },
  {
    version: "0.1.16",
    date: "2026-06-23",
    title: "Correção de travamento na inicialização",
    highlights: [
      "Corrige um travamento (panic) que ocorria ao iniciar o app",
    ],
    tag: "fix",
  },
  {
    version: "0.1.15",
    date: "2026-06-23",
    title: "Correção de dependência no Windows e Serena",
    highlights: [
      "Corrige o erro de biblioteca do Windows (VCRUNTIME140) no processo auxiliar",
      "Integração com o Serena para navegação semântica de código",
    ],
    tag: "fix",
  },
  {
    version: "0.1.14",
    date: "2026-06-23",
    title: "Routines de Specs",
    highlights: [
      "Tarefas recorrentes ligadas às specs do projeto",
    ],
    tag: "feature",
  },
  {
    version: "0.1.13",
    date: "2026-06-23",
    title: "Correção do flash do CMD no Windows",
    highlights: [
      "Elimina o piscar de janelas do prompt de comando no Windows",
    ],
    tag: "fix",
  },
  {
    version: "0.1.11",
    date: "2026-06-23",
    title: "Complexidade ciclomática e diálogos nativos",
    highlights: [
      "Medição de complexidade ciclomática do código",
      "Diálogos nativos do sistema operacional",
    ],
    tag: "feature",
  },
  {
    version: "0.1.10",
    date: "2026-06-23",
    title: "Enviar diagnóstico",
    highlights: [
      "Nova janela para enviar um diagnóstico do app à equipe",
    ],
    tag: "feature",
  },
  {
    version: "0.1.9",
    date: "2026-06-23",
    title: "Correção do feedback ao enviar diagnóstico",
    highlights: [
      "Corrige o retorno visual ao enviar um diagnóstico",
    ],
    tag: "fix",
  },
  {
    version: "0.1.8",
    date: "2026-06-23",
    title: "Diagnóstico, disjuntor e renomeação para OmniRift",
    highlights: [
      "Ferramenta de diagnóstico do app",
      "Disjuntor (circuit breaker) de proteção",
      "Produto renomeado para OmniRift",
      "Link para o grupo de WhatsApp",
    ],
    tag: "feature",
  },
  {
    version: "0.1.7",
    date: "2026-06-23",
    title: "Proteção no fluxo de release",
    highlights: [
      "Proteção no processo de publicação para não recriar rascunhos de release",
    ],
    tag: "infra",
  },
  {
    version: "0.1.6",
    date: "2026-06-23",
    title: "Release 0.1.6",
    highlights: [
      "Publicação da versão 0.1.6",
    ],
    tag: "infra",
  },
  {
    version: "0.1.0",
    date: "2026-06-19",
    title: "Primeiro release (beta)",
    highlights: [
      "Primeira versão pública do OmniRift, em beta",
      "Canvas infinito para orquestrar agentes de IA e terminais",
    ],
    tag: "feature",
  },
];
