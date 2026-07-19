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
    version: "0.1.137",
    date: "2026-07-19",
    title: "Correções no Windows e no terminal que ficava verde após morrer",
    highlights: [
      "Corrigido: quando o programa de um terminal morre na hora de abrir (por exemplo, um CLI que não está instalado), o card agora fica marcado como encerrado em vez de continuar verde como se estivesse trabalhando.",
      "Corrigido: abrir um terminal cujo processo já tinha morrido deixava a tela em branco, sem nenhuma mensagem. Agora um processo novo é iniciado e você vê o erro real na tela, como 'o comando não é reconhecido'.",
      "Corrigido no Windows: o indicador de processo ativo respondia sempre que estava parado, porque usava um caminho que só existe no Linux.",
      "O log agora registra qual programa foi aberto em cada terminal, com que código ele saiu e quanto tempo durou. Com o Modo Debug ligado, isso vai para o arquivo de diagnóstico e permite ao suporte diferenciar um programa que não existe de um que abre e não desenha na tela.",
      "A tela de licença mudou depois de ativar: o campo de colar a chave some e dá lugar a uma confirmação clara, com a data de validade e um botão \"Trocar chave de licença\" para quando você realmente quiser mudar. Ao ativar, aparece um aviso grande na tela — antes só um selo pequenininho no canto indicava que já estava tudo liberado, e dava para colar uma licença em cima da outra sem perceber (obrigado, Eric)",
    ],
    tag: "fix",
  },
  {
    version: "0.1.136",
    date: "2026-07-18",
    title: "Edite o time antes de montar, terminal nativo como padrão, modo Debug e mais",
    highlights: [
      "No Arquiteto de Pipeline agora dá para editar o time antes de montar: mudar nome, modelo, paralelo e descrição de cada agente, remover quem sobrou e adicionar um novo em qualquer onda",
      "Renomear um agente atualiza junto as conexões, os subagentes e o caminho crítico",
      "O Arquiteto passa a montar em terminal nativo por padrão; a escolha fica salva para a próxima vez",
      "Novo Modo Debug em Configurações › Geral: liga a coleta detalhada de log e gera um arquivo de diagnóstico em texto puro para anexar ao suporte",
      "Corrigido: colar a chave de licença junto com o número da lista (ex: \"04 lic_abc123\") não dá mais \"licença inválida\" — a chave é extraída do texto colado",
      "O orquestrador não consegue mais duplicar agente trocando o nome: se já existe alguém livre naquele papel, o sistema recusa, mostra quem está disponível e manda delegar",
      "Corrigido no Windows: a lista de programas (PATH) era montada com o separador do Linux, o que apagava silenciosamente a pasta de ferramentas do OmniRift e a do sistema",
      "Kimi Code entrou no catálogo de instalação de CLIs",
    ],
    tag: "feature",
  },
  {
    version: "0.1.135",
    date: "2026-07-18",
    title: "Guard anti-duplicata no orquestrador",
    highlights: [
      "O orquestrador parou de abrir agentes repetidos: se já existe alguém com aquele nome e livre no canvas, o sistema recusa e manda delegar para ele",
      "A recusa só acontece quando o agente homônimo está parado; se ele está trabalhando, o segundo é permitido, então trabalho paralelo de verdade continua liberado",
    ],
    tag: "fix",
  },
  {
    version: "0.1.134",
    date: "2026-07-18",
    title: "Orçamento de tokens, compactação de conversas e observabilidade",
    highlights: [
      "O /goal agora aceita orçamento de tokens e para sozinho depois de N turnos sem progresso, em vez de queimar contexto à toa",
      "Conversas longas passam a ser resumidas em segundo plano antes de encher, sem travar o que você está fazendo",
      "Novo Inspetor de Execução: uma linha do tempo do que cada agente realmente fez",
      "Chegou a configuração de shell no Windows, incluindo WSL",
      "Corrigido: mandar dois pedidos ao mesmo agente ao mesmo tempo (pelo celular ou pelo canvas) não embaralha mais a conversa",
    ],
    tag: "feature",
  },
  {
    version: "0.1.133",
    date: "2026-07-16",
    title: "Correções no canvas",
    highlights: [
      "Corrigido: pegar um nó pelas bordas voltou a funcionar",
      "Corrigido: os floors não re-renderizam mais várias vezes ao trocar de aba",
    ],
    tag: "fix",
  },
  {
    version: "0.1.132",
    date: "2026-07-15",
    title: "Rotinas, OmniSwitch e build macOS",
    highlights: [
      "Na tela de Rotinas, gatilhos por condição agora aparecem separados dos agendados",
      "O OmniSwitch passou a usar o relógio real para liberar uma chave em espera",
      "Corrigido o empacotamento do aplicativo no macOS",
    ],
    tag: "fix",
  },
  {
    version: "0.1.131",
    date: "2026-07-08",
    title: "Virar um agente em outro papel/modelo + fim do travamento do canvas",
    highlights: [
      "No cabeçalho de qualquer agente, o seletor agora tem \"Virar agente\": troque o terminal por um dos SEUS papéis criados — com a persona + modelo/wrapper dele (skills, MCP, compressor) — não só um CLI cru. Inclusive um agente que morreu vira outro na hora",
      "Corrigido: virar um papel do tipo Shell (ex: wrapper glm/ollama via comando de abertura) agora roda o comando + injeta a persona certo (antes subia vazio e morria)",
      "Canvas não trava mais ao abrir com vários agentes — o seletor checava os CLIs instalados por-nó (dezenas de subprocessos ao renderizar); agora é sob demanda, uma vez só",
      "CLIs não instalados aparecem marcados/desabilitados no seletor, pra você não cair num que não abre",
    ],
    tag: "feature",
  },
  {
    version: "0.1.130",
    date: "2026-07-07",
    title: "OmniSwitch — roteador de chave LLM interno (experimental, desligado por padrão)",
    highlights: [
      "Novo (experimental): um roteador interno de chave LLM — aponta seus agentes pra um endpoint único que escolhe provider/modelo, faz fallback automático e rotaciona chaves quando bate rate-limit",
      "Vem DESLIGADO por padrão (flag \"omniswitch\"): ligue no painel de flags e configure a tabela de roteamento no menu Ferramentas → 🧠 IA & Provedores",
      "Serve Claude (Anthropic) e OpenAI-compat no mesmo endpoint; as chaves ficam no keychain (a tabela guarda só a referência)",
    ],
    tag: "feature",
  },
  {
    version: "0.1.129",
    date: "2026-07-07",
    title: "Estabilidade: fim de travamentos + trocar o LLM de um agente",
    highlights: [
      "O app não trava/cai mais por um erro interno de log — um travamento que aparecia \"do nada\" foi eliminado na raiz",
      "Agora dá pra TROCAR o CLI/LLM de um agente já criado (inclusive um que morreu): um seletor no cabeçalho re-sobe o agente noutro motor mantendo o papel",
      "Quando um agente externo (Hermes) não consegue conectar as ferramentas de orquestração, aparece um aviso claro no agente — antes ele subia \"mudo\", sem as ferramentas, e ninguém sabia por quê",
      "Ligar/desligar um MCP passa a valer na hora para novos agentes e no reload (antes ficava preso numa configuração antiga)",
    ],
    tag: "fix",
  },
  {
    version: "0.1.128",
    date: "2026-07-06",
    title: "Mapa do código: corpo do símbolo sob demanda + fatiador por símbolo",
    highlights: [
      "No OmniGraph, clicar num símbolo (função/classe) mostra o corpo dele sob demanda — sem carregar o arquivo inteiro de uma vez",
      "Novo fatiador de código por símbolo (AST, 10 linguagens): o agente recebe o arquivo já dividido em pedaços que fazem sentido, via a ferramenta code_chunks",
    ],
    tag: "feature",
  },
  {
    version: "0.1.127",
    date: "2026-07-06",
    title: "Subagente: escolha o modelo do wrapper na lista (não digite)",
    highlights: [
      "No dropdown de modelo do subagente, além de herda/haiku/sonnet/opus agora aparecem os seus modelos via wrapper (claude-ollama: glm-5.2, kimi-k2.7…) — prontos pra clicar, sem digitar no “personalizado”",
      "Organizado em dois grupos: “Claude nativo” e “via wrapper (claude-ollama)”. Digitar manual continua como último recurso",
    ],
    tag: "feature",
  },
  {
    version: "0.1.126",
    date: "2026-07-06",
    title: "Nó de Filtro por IA: escolha o modelo numa lista",
    highlights: [
      "No nó Filtro (modo \"por IA — modelo decide\"), ao escolher um provider agora aparece a LISTA de modelos dele — chega de digitar o nome do modelo na mão",
      "A lista vem do catálogo ATUAL do provider (busca ao vivo); se a API não responder, cai no catálogo curado — e sempre dá pra digitar manualmente como último recurso",
    ],
    tag: "feature",
  },
  {
    version: "0.1.125",
    date: "2026-07-06",
    title: "Seus agentes aprendem com os próprios erros",
    highlights: [
      "Novo: todo agente que você monta já vem com o failproof — quando um comando falha e depois passa, a solução fica guardada; se o mesmo erro voltar, o agente recebe o fix conhecido pra não repetir a cilada",
      "No começo de cada sessão, os erros já conhecidos do projeto entram no contexto do agente — ele não tropeça duas vezes na mesma pedra",
      "Distingue palpite (observado) de correção confirmada — nunca empurra suposição como verdade. Roda local e privado, sem instalar nada",
    ],
    tag: "feature",
  },
  {
    version: "0.1.124",
    date: "2026-07-06",
    title: "Time nunca mais trava em silêncio + OmniFS fala a verdade",
    highlights: [
      "Watchdog da orquestração: se o Arquiteto não entrega as fatias e o time fica ocioso, o app cobra o líder sozinho (2 níveis) e depois avisa VOCÊ — e o Code Reviewer é acionado assim que o contrato sai",
      "Painel OmniFS honesto: distingue \"pasta não montada\" de \"drive travado\" (fim do falso ENOTCONN/disco cheio) e o botão de recriar funciona mesmo com daemon OmniFS próprio na máquina",
      "Pasta de Projetos ganha socket dedicado — nunca mais disputa com o seu daemon OmniDrive",
    ],
    tag: "fix",
  },
  {
    version: "0.1.123",
    date: "2026-07-05",
    title: "Agentes conectam de primeira + releases blindados",
    highlights: [
      "Serena e Playwright não aparecem mais como \"failed\" na primeira vez — o app pré-aquece os caches no boot",
      "OmniCompress MCP consertado (handshake do protocolo) — as tools de compressão voltam a conectar",
      "Cada release agora só é publicado depois de um teste automático provar que o app ABRE limpo (quem não abre, não chega em você)",
    ],
    tag: "fix",
  },
  {
    version: "0.1.122",
    date: "2026-07-05",
    title: "Você escolhe os MCPs dos agentes (importação voluntária do Claude global)",
    highlights: [
      "Novo botão em MCP Servers: “Importar do Claude global” — traz os MCPs do seu ~/.claude.json DESLIGADOS, e você liga só o que quiser",
      "No primeiro boot o app importa e avisa sozinho (uma vez) — nada some em silêncio",
      "Complementa a v0.1.121: agente enxuto por padrão + controle total do que cada agente recebe",
    ],
    tag: "feature",
  },
  {
    version: "0.1.121",
    date: "2026-07-05",
    title: "Agentes nascem leves (fim do contexto estourado) + tour removido",
    highlights: [
      "Agentes não herdam mais TODOS os MCPs globais do Claude — antes nasciam com a janela de contexto estourada (~350k tokens) e travavam antes de trabalhar",
      "Tour de onboarding removido: causava travamento na abertura do app (será refeito com calma)",
      "Tooltips longas agora quebram linha em vez de serem cortadas na borda",
    ],
    tag: "fix",
  },
  {
    version: "0.1.120",
    date: "2026-07-04",
    title: "Menu Ferramentas organizado por categorias",
    highlights: [
      "As ferramentas agora em 5 categorias colapsáveis: 🎯 Orquestrar · 🤖 Agentes · 🧠 IA & Provedores · 📁 Projeto & Arquivos · ⚙️ App & Sistema",
      "Abra só a categoria que quer (o estado fica salvo); arrastar pra reordenar continua funcionando dentro de cada grupo",
    ],
    tag: "feature",
  },
  {
    version: "0.1.119",
    date: "2026-07-04",
    title: "Terminal-Bench: explica por que precisa de agente + botão pra criar um",
    highlights: [
      "Quando não há agente pro bench, a tela agora explica: ele precisa de um AGENTE estruturado (um terminal comum é “cego” e não serve)",
      "Botão “Criar um agente pra testar” — monta o AgentNode certo na hora, sem sair do bench",
    ],
    tag: "feature",
  },
  {
    version: "0.1.118",
    date: "2026-07-04",
    title: "Modelos do subagente listam de verdade (dinâmico) + tooltip embaçado removido",
    highlights: [
      "O picker de modelo lista o catálogo ATUAL do provider (era bug: a URL do Ollama saía sem /v1 e vinha vazia) — agora traz os modelos de verdade e sempre frescos",
      "Fallback pro teu catálogo curado (claude-ollama) se a API falhar; como os modelos mudam/expiram, busca ao vivo a cada abertura",
      "Removido o tooltip 'Duplo-clique para renomear' que ficava escuro/embaçado sobre o header do agente",
    ],
    tag: "fix",
  },
  {
    version: "0.1.117",
    date: "2026-07-04",
    title: "Subagente: escolha QUALQUER modelo do provider (catálogo completo)",
    highlights: [
      "No editor de subagente, cada provider expande e lista TODOS os seus modelos — kimi-k2.7-code, glm-5.2, deepseek-v4-pro… não só o default",
      "O modelo grava no campo model: do arquivo e é roteado pelo teu proxy (claude-ollama) — qualquer modelo do catálogo funciona no subagente",
    ],
    tag: "feature",
  },
  {
    version: "0.1.116",
    date: "2026-07-04",
    title: "Editor completo de subagente: papel, persona e LLM de verdade",
    highlights: [
      "Botão ✎ no subagente abre um editor — reescreva o papel/persona, parta de templates prontos (DBA, Security, QA…)",
      "Modelo/LLM vira uma galeria dos teus providers da Central (fim da digitação cega), com aviso honesto do que subagente nativo aceita",
      "Preview do arquivo .claude/agents/*.md que será gravado, antes de salvar",
    ],
    tag: "feature",
  },
  {
    version: "0.1.115",
    date: "2026-07-04",
    title: "Fim do terminal preto quando a GPU fica sob pressão",
    highlights: [
      "Corrige o terminal do agente ficando PRETO quando o WebKitGTK perde o contexto de GPU (VM/navegadores disputando a placa)",
      "Ao perder o contexto WebGL, o terminal cai pro renderer normal e se redesenha sozinho — sem tela preta, sem precisar recarregar",
    ],
    tag: "fix",
  },
  {
    version: "0.1.114",
    date: "2026-07-04",
    title: "Aprender: barra de progresso da trilha + exercício vira card no Kanban",
    highlights: [
      "Barra de progresso no modo Aprender — veja de relance o que já resolveu (persiste entre sessões); clique num segmento pra pular pro exercício",
      "Ao concluir um exercício, ele vira um card 🎓 na coluna 'done' do Kanban do projeto",
      "Tutor ancorado (A3) validado ponta a ponta: consulta doc real de libs via Context7",
    ],
    tag: "feature",
  },
  {
    version: "0.1.113",
    date: "2026-07-04",
    title: "Tutor Aprender não alucina mais: consulta a doc real (Aprender A3)",
    highlights: [
      "O tutor do modo Aprender consulta documentação ao vivo de libs (Context7) em vez de inventar API",
      "Ancorado no código do teu projeto (roda no cwd) — ensino fundamentado, não chute",
      "Se a consulta falhar, cai no modo normal sozinho (o tutor nunca quebra)",
    ],
    tag: "feature",
  },
  {
    version: "0.1.112",
    date: "2026-07-04",
    title: "Auto-evoluir com segurança: o ajuste de role só fica se não piorar o bench",
    highlights: [
      "No 🔬 Avaliar trajetória: 'Aplicar + validar no bench' aplica o ajuste do role e roda o Terminal-Bench",
      "Se o selo do bench cair, o ajuste é REVERTIDO sozinho — o role nunca piora (regression guard fechado)",
      "Cada role guarda seu baseline de bench; o loop conecta o Evolver ao Terminal-Bench",
    ],
    tag: "feature",
  },
  {
    version: "0.1.111",
    date: "2026-07-04",
    title: "Avaliar trajetória do agente (juiz de IA + ajuste de role)",
    highlights: [
      "Botão 🔬 no agente: um juiz de IA pontua a trajetória (o caminho que o agente seguiu) e mostra onde ele derivou",
      "Sugere um ajuste na persona do role pra evitar os desvios recorrentes — com botão 'Aplicar ao role'",
      "Usa o histórico do agente + o sinal de erro/latência; nenhum custo extra além da chamada do juiz",
    ],
    tag: "feature",
  },
  {
    version: "0.1.110",
    date: "2026-07-04",
    title: "Docs no canvas: não somem mais ao abrir + botão pra ocultar",
    highlights: [
      "Corrige o doc .md sumindo do canvas ao clicar num link interno (o terminal do navegador navegava a página toda)",
      "Links http dentro dos docs agora abrem no navegador externo",
      "'Limpar docs do canvas' (menu ▾): remove a seção de documentação depois de analisar",
    ],
    tag: "fix",
  },
  {
    version: "0.1.109",
    date: "2026-07-04",
    title: "Mapa do Código: só código no 'coração' + explorar docs no canvas",
    highlights: [
      "O 'coração do código' mostra só código real (funções) — seções de documentação não poluem mais a lista",
      "'Explorar docs no canvas' (menu ▾ e no painel): os .md do projeto viram uma seção de nós pra abrir e ler",
    ],
    tag: "feature",
  },
  {
    version: "0.1.108",
    date: "2026-07-04",
    title: "Mapa do Código agora te DIZ algo (painel de leitura) + limpar o grafo do canvas",
    highlights: [
      "O botão 'Mapa do código' abre um PAINEL legível: coração do código (mais conectados), conexões surpresa, ciclos de import, peças soltas — em vez de só despejar bolhas sem nome",
      "'Limpar grafo do canvas' (no menu ▾) remove as bolhas do grafo de uma vez, sem tocar nos agentes",
      "As visões visuais (comunidades/chamadas/deps/risco) continuam em 'Ver no canvas ▾'",
    ],
    tag: "feature",
  },
  {
    version: "0.1.107",
    date: "2026-07-04",
    title: "Delete no agente clicado deleta de verdade",
    highlights: [
      "Delete apaga o agente que está com o cursor nele — o terminal não engole mais a tecla",
      "(o fix anterior não pegava: o campo escondido de teclado do terminal interceptava o Delete)",
    ],
    tag: "fix",
  },
  {
    version: "0.1.106",
    date: "2026-07-04",
    title: "Delete apaga o agente clicado + Mapa do Código gera de verdade",
    highlights: [
      "Tecla Delete apaga o agente clicado — antes o terminal engolia a tecla e nada acontecia",
      "O Mapa do Código (OmniGraph) agora gera na 1ª vez — antes caía sempre em 'grafo vazio'",
      "Debug nativo grava cada passo do Mapa do Código no ~/.omnirift/debug.log",
    ],
    tag: "fix",
  },
  {
    version: "0.1.105",
    date: "2026-07-04",
    title: "Mapa do Código mais limpo (nada de pasta estranha no projeto)",
    highlights: [
      "A saída do Mapa do Código (OmniGraph) vai pra .omnirift/omnigraph — sua pasta fica limpa",
      "Corrige perda de dados ao mover pastas dentro do drive dos agentes (OmniFS)",
    ],
    tag: "fix",
  },
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
