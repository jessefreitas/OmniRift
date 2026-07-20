//! Emulador VT headless **dono no backend** (ref P0 #2, decisão A aprovada).
//!
//! Hoje cada `@xterm/xterm` no canvas é dono do seu scrollback; o PTY só faz pipe
//! de bytes. Nó oculto + agente barulhento = renderer retém MB de bytes não-parseados
//! → crash. A solução é inverter a posse: este `TermEmulator` (um
//! `alacritty_terminal::Term` + `vte::ansi::Processor`) vira a fonte da verdade no
//! backend; o front vira view descartável que re-hidrata via `snapshot()`.
//!
//! ## Pontos finos (do RE `docs/research/ref-re/02-terminal.md`)
//! - **RESPONDE queries** (DA1/DSR/OSC10-11) e é o ÚNICO respondedor da sessão. O
//!   desenho anterior delegava isso ao xterm do front, mas no eager-spawn não existe
//!   xterm — a query se perdia e a TUI morria com código 1 esperando o CPR. Tentar
//!   alternar a autoridade por flag (`view_attached`) tem corrida irredutível: os
//!   bytes chegam aqui na hora e no xterm ~16ms depois (debounce), então quando o
//!   xterm vê a query o backend já respondeu. Agora o front bloqueia suas respostas
//!   locais (CSI no parser; OSC 10/11 no `onData`) e a autoridade é só daqui — sem janela.
//! - **Scrollback bounded 10_000** (`Config::scrolling_history`) → MBs, não GBs.
//! - **`seq: u64` monotônico** por sessão, incrementa a cada `feed` — chave do dedup do
//!   front (descarta chunks ao vivo com `seq <= snapshot.seq`, mata o scrollback dobrado).
//!
//! API confirmada na v0.26.0 (não chutada): `Term::new<D: Dimensions>(Config, &D, T)`,
//! `Processor::advance(&mut handler, &[u8])` (Term é `vte::ansi::Handler`),
//! `grid().iter_from(Point::new(topmost_line, Column(0)))` → `Indexed<&Cell>`,
//! `Cell { c, fg, bg, flags }`, `Color::{Named,Spec,Indexed}`, `TermMode::ALT_SCREEN`.

use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, NamedColor, Processor, Rgb};

use parking_lot::Mutex;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// Scrollback máximo retido pelo emulador (linhas). Bounded de propósito: um agente
/// em loop não pode pinnizar GBs no backend. A UI pode pedir uma janela menor ao
/// remontar uma view; o histórico maior continua disponível como fonte de verdade.
pub const SCROLLBACK_LIMIT: usize = 10_000;

/// Cap de segurança do snapshot serializado (bytes). Evita IPC gigante mesmo com
/// linhas largas/coloridas. ~4 MB cobre 10k linhas com SGR folgado.
pub const SNAPSHOT_MAX_BYTES: usize = 4 * 1024 * 1024;

/// Tema inicial compartilhado com `useTerminalSession`. Estes valores também são o
/// fallback depois de OSC 110/111 (reset da cor dinâmica).
const DEFAULT_FOREGROUND: Rgb = Rgb {
    r: 0xed,
    g: 0xee,
    b: 0xf0,
};
const DEFAULT_BACKGROUND: Rgb = Rgb {
    r: 0x0a,
    g: 0x10,
    b: 0x14,
};

#[derive(Debug, Clone, Copy)]
struct DynamicColors {
    foreground: Rgb,
    background: Rgb,
}

impl Default for DynamicColors {
    fn default() -> Self {
        Self {
            foreground: DEFAULT_FOREGROUND,
            background: DEFAULT_BACKGROUND,
        }
    }
}

/// Snapshot serializado do grid+scrollback, cruzando o IPC pro front re-hidratar.
/// `data` = ANSI re-hidratado (SGR por célula + reentra alt-screen se ativo).
/// `seq` = valor pintado NESTE snapshot — chave do dedup dos chunks ao vivo.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySnapshot {
    pub data: String,
    pub cols: u16,
    pub rows: u16,
    pub seq: u64,
}

/// Dimensões pro `Term` (mirror do `TermSize` interno de teste do crate). `total_lines`
/// = screen_lines pra construção; o scrollback real cresce via `Config::scrolling_history`.
#[derive(Debug, Clone, Copy)]
struct EmuSize {
    cols: usize,
    rows: usize,
}

impl Dimensions for EmuSize {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

/// Emulador VT headless de uma sessão PTY. Envolve um `Term` (grid + scrollback
/// bounded) + um `Processor` (parser ANSI stateful). Single-threaded por design: o
/// caller serializa os `feed` (1 read-loop por sessão); o `PtyManager` guarda cada
/// um sob `Mutex` pra leitura concorrente do `snapshot`.
/// Respondedor de queries da sessão (DSR/DA/OSC). Acumula as respostas que o `Term`
/// computa; o `read_loop` drena e escreve na stdin do PTY logo após cada `feed`.
/// É o ÚNICO respondedor — o front barra as respostas locais antes de chegarem ao PTY.
#[derive(Clone)]
pub struct BackstopListener {
    pending: Arc<Mutex<Vec<Vec<u8>>>>,
    /// Compartilhado com o TermEmulator: o `resize` atualiza aqui, senão responderia
    /// TextAreaSizeRequest com o tamanho de quando a sessão nasceu.
    dims: Arc<Mutex<(u16, u16)>>,
    /// Estado dinâmico de OSC 10/11. O listener não enxerga diretamente o `Term`,
    /// portanto o emulador sincroniza este espelho depois de cada OSC completo.
    dynamic_colors: Arc<Mutex<DynamicColors>>,
}

/// Teto do buffer de respostas: se ninguém drenar (sessão morta), não crescemos sem
/// limite — descartamos em vez de segurar memória.
const MAX_PENDING_RESPONSES: usize = 256;

impl EventListener for BackstopListener {
    fn send_event(&self, event: Event) {
        let resposta = match event {
            Event::PtyWrite(s) => s,
            // SÓ foreground (OSC 10) e background (OSC 11). A resposta precisa refletir
            // SET/RESET anteriores, não apenas o tema de nascimento da view.
            //
            // OSC 4/12 ficam deliberadamente sem backstop: com view, o xterm responde;
            // no eager-spawn não há respondedor. Isso é risco aceito e explícito, não
            // resolvido. Responder aqui sem uma paleta/cursor autoritativos seria errado.
            Event::ColorRequest(idx, f) => {
                let colors = *self.dynamic_colors.lock();
                if idx == NamedColor::Foreground as usize {
                    f(colors.foreground)
                } else if idx == NamedColor::Background as usize {
                    f(colors.background)
                } else {
                    return;
                }
            }
            Event::TextAreaSizeRequest(f) => {
                let (cols, rows) = *self.dims.lock();
                // Célula em pixels não existe no backend (headless): 8x16 é o padrão de
                // facto. Só afeta quem pergunta o tamanho em PIXELS; em células (CSI 18t)
                // a resposta é exata.
                f(WindowSize {
                    num_lines: rows,
                    num_cols: cols,
                    cell_width: 8,
                    cell_height: 16,
                })
            }
            _ => return,
        };
        let mut pend = self.pending.lock();
        if pend.len() >= MAX_PENDING_RESPONSES {
            return;
        }
        pend.push(resposta.into_bytes());
    }
}

/// Estados da maquina de estados para detectar a requisicao DSR privado (DECXCPR).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
enum EstadoDsr {
    #[default]
    Ocioso,
    ViuEsc,
    ViuColchete,
    ViuInterrogacao,
}

/// Detector de requisicoes DSR privado no fluxo de bytes.
///
/// O VTE nao despacha `CSI ? <params> n`, entao precisamos detectar no stream
/// para responder com DECXCPR (`ESC [ ? <linha> ; <coluna> ; 1 R`).
#[derive(Debug, Default)]
pub struct DetectorDsrPrivado {
    estado: EstadoDsr,
}

impl DetectorDsrPrivado {
    /// Escaneia um pedaco de bytes e devolve quantas requisicoes DSR privado
    /// completas foram encontradas. A sequencia pode estar partida entre
    /// chamadas; o estado persiste na struct.
    pub fn scan(&mut self, bytes: &[u8]) -> usize {
        let mut encontradas = 0usize;

        for &byte in bytes {
            match self.estado {
                EstadoDsr::Ocioso => {
                    if byte == 0x1B {
                        self.estado = EstadoDsr::ViuEsc;
                    }
                    // Qualquer outro byte: continua ocioso.
                }
                EstadoDsr::ViuEsc => {
                    if byte == b'[' {
                        self.estado = EstadoDsr::ViuColchete;
                    } else if byte == 0x1B {
                        // ESC repetido reinicia o escape.
                        self.estado = EstadoDsr::ViuEsc;
                    } else {
                        self.estado = EstadoDsr::Ocioso;
                    }
                }
                EstadoDsr::ViuColchete => {
                    if byte == b'?' {
                        self.estado = EstadoDsr::ViuInterrogacao;
                    } else if byte == 0x1B {
                        self.estado = EstadoDsr::ViuEsc;
                    } else {
                        self.estado = EstadoDsr::Ocioso;
                    }
                }
                EstadoDsr::ViuInterrogacao => {
                    if byte.is_ascii_digit() || byte == b';' {
                        // Continua coletando parametros.
                        self.estado = EstadoDsr::ViuInterrogacao;
                    } else if byte == b'n' {
                        // Requisicao DSR privado completa.
                        encontradas += 1;
                        self.estado = EstadoDsr::Ocioso;
                    } else if byte == 0x1B {
                        self.estado = EstadoDsr::ViuEsc;
                    } else {
                        // Ex: `ESC [ ? 25 h` (DECTCEM) nao e DSR.
                        self.estado = EstadoDsr::Ocioso;
                    }
                }
            }
        }

        encontradas
    }
}

/// Estado mínimo para achar o fim de OSC sem reimplementar o parser VT. Usamos as
/// fronteiras para sincronizar as cores depois de cada OSC completo; isso preserva a
/// ordem quando um mesmo chunk contém `SET`, depois `QUERY`.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
enum EstadoOsc {
    #[default]
    Fora,
    ViuEscFora,
    Dentro,
    ViuEscDentro,
}

#[derive(Debug, Default)]
struct DetectorFimOsc {
    estado: EstadoOsc,
}

impl DetectorFimOsc {
    /// Devolve offsets EXCLUSIVOS das terminações de OSC encontradas neste chunk.
    /// O estado persiste para sequências partidas entre reads do PTY.
    fn boundaries(&mut self, bytes: &[u8]) -> Vec<usize> {
        let mut ends = Vec::new();

        for (index, &byte) in bytes.iter().enumerate() {
            self.estado = match self.estado {
                EstadoOsc::Fora => match byte {
                    0x1b => EstadoOsc::ViuEscFora,
                    0x9d => EstadoOsc::Dentro, // C1 OSC
                    _ => EstadoOsc::Fora,
                },
                EstadoOsc::ViuEscFora => match byte {
                    b']' => EstadoOsc::Dentro,
                    0x1b => EstadoOsc::ViuEscFora,
                    0x9d => EstadoOsc::Dentro,
                    _ => EstadoOsc::Fora,
                },
                EstadoOsc::Dentro => match byte {
                    0x07 | 0x9c => {
                        ends.push(index + 1); // BEL ou C1 ST
                        EstadoOsc::Fora
                    }
                    0x1b => EstadoOsc::ViuEscDentro,
                    _ => EstadoOsc::Dentro,
                },
                EstadoOsc::ViuEscDentro => match byte {
                    b'\\' => {
                        ends.push(index + 1); // ESC \\ (ST)
                        EstadoOsc::Fora
                    }
                    0x07 | 0x9c => {
                        ends.push(index + 1);
                        EstadoOsc::Fora
                    }
                    0x1b => EstadoOsc::ViuEscDentro,
                    _ => EstadoOsc::Dentro,
                },
            };
        }

        ends
    }
}

pub struct TermEmulator {
    term: Term<BackstopListener>,
    pending: Arc<Mutex<Vec<Vec<u8>>>>,
    /// Dimensões vistas pelo respondedor, atualizadas no `resize`.
    dims: Arc<Mutex<(u16, u16)>>,
    dynamic_colors: Arc<Mutex<DynamicColors>>,
    parser: Processor,
    osc_boundaries: DetectorFimOsc,
    /// Detector de `CSI ? .. n` (DSR privado). O vte NAO despacha essa variante, entao
    /// sem isto ninguem responde e a TUI headless morre esperando o DECXCPR.
    dsr_privado: DetectorDsrPrivado,
    /// `seq` monotônico por sessão, em `Arc<AtomicU64>` pra ser COMPARTILHADO com o
    /// thread de emit do `pty://output` (em `session.rs`) — assim o evento ao vivo
    /// carrega o MESMO seq que o emulador pintou, e o front deduplica os chunks ao
    /// vivo contra `snapshot.seq` (descarta `seq <= snapshot.seq` → mata o scrollback
    /// dobrado). Sem o Arc, o emit (outro thread, outra fronteira de chunk) não teria
    /// como saber o seq atual do grid.
    seq: Arc<AtomicU64>,
    cols: u16,
    rows: u16,
}

impl TermEmulator {
    /// Cria o emulador nas dimensões iniciais da sessão, com scrollback bounded.
    /// O `seq` é interno (não compartilhado) — usado em testes e no path standalone.
    pub fn new(cols: u16, rows: u16) -> Self {
        Self::new_with_seq(cols, rows, Arc::new(AtomicU64::new(0)))
    }

    /// Como `new`, mas reutiliza um `seq` compartilhado (vindo do `PtySession`), pro
    /// thread de emit do `pty://output` estampar cada evento com o seq do grid. Aditivo:
    /// o caminho de produção usa esta; `new` (seq próprio) cobre testes/standalone.
    pub fn new_with_seq(cols: u16, rows: u16, seq: Arc<AtomicU64>) -> Self {
        let (cols, rows) = (cols.max(1), rows.max(1));
        let config = Config {
            scrolling_history: SCROLLBACK_LIMIT,
            ..Config::default()
        };
        let size = EmuSize {
            cols: cols as usize,
            rows: rows as usize,
        };
        let pending = Arc::new(Mutex::new(Vec::new()));
        let dims = Arc::new(Mutex::new((cols, rows)));
        let dynamic_colors = Arc::new(Mutex::new(DynamicColors::default()));
        let listener = BackstopListener {
            pending: Arc::clone(&pending),
            dims: Arc::clone(&dims),
            dynamic_colors: Arc::clone(&dynamic_colors),
        };
        let term = Term::new(config, &size, listener);
        Self {
            term,
            parser: Processor::new(),
            osc_boundaries: DetectorFimOsc::default(),
            dsr_privado: DetectorDsrPrivado::default(),
            seq,
            cols,
            rows,
            pending,
            dims,
            dynamic_colors,
        }
    }

    /// Alimenta bytes do PTY no grid. `seq += 1` por chamada (1 chunk pintado). O
    /// backstop acumula respostas de query para o read-loop devolver ao PTY.
    pub fn feed(&mut self, bytes: &[u8]) {
        // Um read pode trazer `OSC 10;cor`, depois `OSC 10;?`. Se entregássemos tudo
        // ao parser de uma vez e sincronizássemos só no fim, a query responderia a cor
        // velha. Cortamos apenas nas terminações OSC: não alimentamos o parser byte a
        // byte no fluxo normal.
        let boundaries = self.osc_boundaries.boundaries(bytes);
        let mut start = 0usize;
        for end in boundaries {
            self.parser.advance(&mut self.term, &bytes[start..end]);
            self.sync_dynamic_colors();
            start = end;
        }
        if start < bytes.len() {
            self.parser.advance(&mut self.term, &bytes[start..]);
        }
        // DSR privado: o vte nao despacha `CSI ? .. n`, entao detectamos e sintetizamos
        // o DECXCPR aqui. Sem view montada (eager-spawn) nao existe xterm pra responder,
        // e a TUI fica esperando ate morrer com codigo 1 — o defeito original.
        let pedidos = self.dsr_privado.scan(bytes);
        if pedidos > 0 {
            let ponto = self.term.grid().cursor.point;
            let resposta = format!("\x1b[?{};{};1R", ponto.line.0 + 1, ponto.column.0 + 1);
            let mut pend = self.pending.lock();
            for _ in 0..pedidos {
                if pend.len() >= MAX_PENDING_RESPONSES {
                    break;
                }
                pend.push(resposta.clone().into_bytes());
            }
        }
        self.seq.fetch_add(1, Ordering::SeqCst);
    }

    fn sync_dynamic_colors(&self) {
        let colors = self.term.colors();
        let mut dynamic = self.dynamic_colors.lock();
        dynamic.foreground = colors[NamedColor::Foreground].unwrap_or(DEFAULT_FOREGROUND);
        dynamic.background = colors[NamedColor::Background].unwrap_or(DEFAULT_BACKGROUND);
    }

    /// Drena as respostas de query acumuladas pelo backstop. O read-loop chama isto
    /// depois de cada `feed` e escreve o resultado na stdin do PTY.
    pub fn take_pending_responses(&self) -> Vec<Vec<u8>> {
        std::mem::take(&mut *self.pending.lock())
    }

    /// Redimensiona o grid (o read-loop chama junto com o resize do PTY master).
    pub fn resize(&mut self, cols: u16, rows: u16) {
        let (cols, rows) = (cols.max(1), rows.max(1));
        self.cols = cols;
        self.rows = rows;
        // O backstop lê daqui: sem isto ele responderia o tamanho do nascimento.
        *self.dims.lock() = (cols, rows);
        self.term.resize(EmuSize {
            cols: cols as usize,
            rows: rows as usize,
        });
    }

    /// Seq atual (último chunk pintado). Exposto pra testes/diagnóstico.
    pub fn seq(&self) -> u64 {
        self.seq.load(Ordering::SeqCst)
    }

    /// Serializa scrollback (até `scrollback_rows`) + viewport em ANSI re-hidratado.
    ///
    /// Estratégia (espelha `rehydrateSequences + snapshotAnsi` do ref):
    /// 1. Se alt-screen ativo, prefixa `\x1b[?1049h` (reentra o alt buffer) e força
    ///    scrollback=0 (o conteúdo visível É o alt-screen; replayar scrollback dobra).
    /// 2. Caminha o grid de `topmost_line` (clampado a `scrollback_rows` acima do
    ///    viewport) até a última linha, emitindo SGR (fg/bg + bold/italic/underline/
    ///    inverse/dim/strikeout) só quando muda, e `\x1b[0m\r\n` no fim de cada linha.
    /// 3. Cap de segurança em `SNAPSHOT_MAX_BYTES` (corta linhas mais antigas).
    pub fn snapshot(&self, scrollback_rows: usize) -> PtySnapshot {
        let grid = self.term.grid();
        let is_alt = self.term.mode().contains(TermMode::ALT_SCREEN);

        let mut out = String::new();
        if is_alt {
            // Reentra o alt-screen ANTES do dump, pra o front re-hidratar no buffer certo.
            out.push_str("\x1b[?1049h");
        }

        let cols = grid.columns();
        let screen_lines = grid.screen_lines();
        // Em alt-screen, só o viewport (scrollback=0). Senão, até scrollback_rows acima.
        let history = if is_alt {
            0
        } else {
            grid.history_size().min(scrollback_rows)
        };
        let top = -(history as i32);
        let bottom = screen_lines as i32 - 1;

        // Indexação explícita por `grid[Point]` (não `iter_from`): o `GridIterator::next`
        // PRÉ-AVANÇA o ponto antes de yieldar, então o `iter_from` pula a 1ª célula. O
        // acesso direto por Point evita esse off-by-one e é mais claro pro walk completo.
        let mut lines: Vec<String> = Vec::new();
        let mut line_cells: Vec<Cell> = Vec::with_capacity(cols);
        for line in top..=bottom {
            line_cells.clear();
            for col in 0..cols {
                line_cells.push(grid[Point::new(Line(line), Column(col))].clone());
            }
            lines.push(render_line(&line_cells));
        }

        // Tira linhas em branco do FIM: emitir `\r\n` extra empurraria o cursor e
        // scrollaria o conteúdo no replay (o "RED" cairia no scrollback). Mantém as
        // linhas em branco do MEIO (preservam o layout do viewport).
        while lines.last().map(|l| l.is_empty()).unwrap_or(false) {
            lines.pop();
        }

        // Junta com `\r\n` como SEPARADOR (não terminador) — sem `\r\n` no fim, pra o
        // replay não rolar a tela além do conteúdo.
        // Cap por LINHAS, não por bytes: cortar no meio de uma sequência ANSI (ex.: \x1b[31m)
        // corromperia o SGR no front (is_char_boundary protege UTF-8, não escape). Remove as
        // linhas mais antigas até caber. (+2 ≈ o \r\n separador.) [GLM-audit #2]
        let mut total: usize = lines.iter().map(|l| l.len() + 2).sum();
        while total > SNAPSHOT_MAX_BYTES && lines.len() > 1 {
            total -= lines.remove(0).len() + 2;
        }
        out.push_str(&lines.join("\r\n"));

        PtySnapshot {
            data: out,
            cols: self.cols,
            rows: self.rows,
            seq: self.seq.load(Ordering::SeqCst),
        }
    }
}

/// Renderiza UMA linha do grid em ANSI: SGR diferencial por célula + reset no fim.
/// Faz trim da cauda de células default (espaço com bg default) — não inflar o
/// snapshot nem carregar SGR/espaço inútil. Devolve `""` pra linha totalmente em
/// branco (o caller decide juntar com `\r\n` e podar as do fim). Cada linha começa
/// do estado default (sem SGR herdado), então é auto-contida.
fn render_line(cells: &[Cell]) -> String {
    // Última coluna com conteúdo (char não-espaço OU bg não-default).
    let mut last_idx: isize = -1;
    for (i, c) in cells.iter().enumerate() {
        // Conteúdo OU bg/fg/flags não-default — um espaço sublinhado/colorido na cauda
        // NÃO é "vazio" e não pode ser podado. [GLM-audit #3]
        if c.c != ' '
            || c.bg != Color::Named(NamedColor::Background)
            || c.fg != Color::Named(NamedColor::Foreground)
            || !c.flags.is_empty()
        {
            last_idx = i as isize;
        }
    }
    if last_idx < 0 {
        return String::new(); // linha em branco
    }

    let mut out = String::new();
    let mut last_sgr: Option<String> = None;
    let mut styled = false;
    for c in cells.iter().take((last_idx + 1) as usize) {
        // Célula spacer de um wide char (emoji/CJK): o char largo já saiu na célula
        // líder; emitir o placeholder aqui empurraria a linha 1 coluna. [GLM-audit #4]
        if c.flags.contains(Flags::WIDE_CHAR_SPACER) {
            continue;
        }
        let sgr = sgr_for(c);
        if last_sgr.as_deref() != Some(sgr.as_str()) {
            out.push_str(&sgr);
            last_sgr = Some(sgr.clone());
            if sgr != "\x1b[0m" {
                styled = true;
            }
        }
        out.push(if c.c == '\0' { ' ' } else { c.c });
    }
    // Reset no fim só se a linha emitiu algum estilo (mantém limpo o caso só-texto).
    if styled {
        out.push_str("\x1b[0m");
    }
    out
}

/// Monta a sequência SGR de uma célula (`\x1b[...m`). Cobre fg/bg + bold/italic/
/// underline/inverse/dim/strikeout — o suficiente pro round-trip de cor/estilo
/// sobreviver. Sempre começa de `0` (reset) pra ser independente do estado anterior.
fn sgr_for(cell: &Cell) -> String {
    let mut parts: Vec<String> = vec!["0".to_string()];
    let f = cell.flags;
    if f.contains(Flags::BOLD) {
        parts.push("1".into());
    }
    if f.contains(Flags::DIM) {
        parts.push("2".into());
    }
    if f.contains(Flags::ITALIC) {
        parts.push("3".into());
    }
    if f.contains(Flags::UNDERLINE) {
        parts.push("4".into());
    }
    if f.contains(Flags::INVERSE) {
        parts.push("7".into());
    }
    if f.contains(Flags::STRIKEOUT) {
        parts.push("9".into());
    }
    if let Some(s) = sgr_color(cell.fg, true) {
        parts.push(s);
    }
    if let Some(s) = sgr_color(cell.bg, false) {
        parts.push(s);
    }
    format!("\x1b[{}m", parts.join(";"))
}

/// Codifica uma cor de célula como parâmetro(s) SGR. `fg=true` → 30-37/90-97/38;
/// `fg=false` → 40-47/100-107/48. Devolve `None` pra cor default (já coberta pelo `0`).
fn sgr_color(color: Color, fg: bool) -> Option<String> {
    match color {
        Color::Named(NamedColor::Foreground) | Color::Named(NamedColor::Background) => None,
        Color::Named(named) => {
            let base = named_to_sgr(named)?;
            Some(encode_named(base, fg))
        }
        Color::Spec(Rgb { r, g, b }) => {
            let lead = if fg { 38 } else { 48 };
            Some(format!("{lead};2;{r};{g};{b}"))
        }
        Color::Indexed(idx) => {
            let lead = if fg { 38 } else { 48 };
            Some(format!("{lead};5;{idx}"))
        }
    }
}

/// Mapeia um `NamedColor` da paleta de 16 pro índice base 0..=15 (None pros não-paleta,
/// que caem no `0`/default — cobre Cursor/Dim*/Bright(Fore|Back)ground especiais).
fn named_to_sgr(named: NamedColor) -> Option<u8> {
    let v = match named {
        NamedColor::Black => 0,
        NamedColor::Red => 1,
        NamedColor::Green => 2,
        NamedColor::Yellow => 3,
        NamedColor::Blue => 4,
        NamedColor::Magenta => 5,
        NamedColor::Cyan => 6,
        NamedColor::White => 7,
        NamedColor::BrightBlack => 8,
        NamedColor::BrightRed => 9,
        NamedColor::BrightGreen => 10,
        NamedColor::BrightYellow => 11,
        NamedColor::BrightBlue => 12,
        NamedColor::BrightMagenta => 13,
        NamedColor::BrightCyan => 14,
        NamedColor::BrightWhite => 15,
        _ => return None,
    };
    Some(v)
}

/// Converte índice 0..=15 + flag fg/bg no número SGR (30-37 / 90-97 / 40-47 / 100-107).
fn encode_named(base: u8, fg: bool) -> String {
    let n = if base < 8 {
        if fg {
            30 + base
        } else {
            40 + base
        }
    } else if fg {
        90 + (base - 8)
    } else {
        100 + (base - 8)
    };
    n.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn single_response(emu: &TermEmulator) -> String {
        let responses = emu.take_pending_responses();
        assert_eq!(
            responses.len(),
            1,
            "esperava exatamente uma resposta: {responses:?}"
        );
        String::from_utf8(responses.into_iter().next().unwrap()).unwrap()
    }

    /// Acha a célula `(line, col)` no grid re-parseado, pra checar cor/estilo round-trip.
    fn cell_at(emu: &TermEmulator, line: i32, col: usize) -> Cell {
        emu.term.grid()[Point::new(Line(line), Column(col))].clone()
    }

    #[test]
    fn feed_text_appears_in_snapshot() {
        let mut e = TermEmulator::new(80, 24);
        e.feed(b"foo\r\nbar");
        let snap = e.snapshot(SCROLLBACK_LIMIT);
        assert!(
            snap.data.contains("foo"),
            "snapshot deve conter foo: {:?}",
            snap.data
        );
        assert!(
            snap.data.contains("bar"),
            "snapshot deve conter bar: {:?}",
            snap.data
        );
    }

    #[test]
    fn seq_increments_per_feed() {
        let mut e = TermEmulator::new(80, 24);
        assert_eq!(e.seq(), 0);
        e.feed(b"a");
        assert_eq!(e.seq(), 1);
        e.feed(b"b");
        assert_eq!(e.seq(), 2);
        // O seq do snapshot reflete o último chunk pintado.
        assert_eq!(e.snapshot(SCROLLBACK_LIMIT).seq, 2);
    }

    #[test]
    fn scrollback_is_bounded_to_limit() {
        let mut e = TermEmulator::new(80, 24);
        // 20k linhas numeradas → o grid só pode reter SCROLLBACK_LIMIT (+ viewport).
        let mut input = String::new();
        for i in 0..20_000 {
            input.push_str(&format!("L{i}\r\n"));
        }
        e.feed(input.as_bytes());
        let snap = e.snapshot(SCROLLBACK_LIMIT);
        let line_count = snap.data.matches("\r\n").count();
        assert!(
            line_count <= SCROLLBACK_LIMIT + 24 + 1,
            "scrollback bounded: {line_count} linhas (limite {SCROLLBACK_LIMIT} + viewport)"
        );
        // As linhas mais antigas caíram; as recentes ficaram.
        assert!(
            snap.data.contains("L19999"),
            "linha mais recente deve sobreviver"
        );
        assert!(
            !snap.data.contains("L0\r\n"),
            "linha 0 deve ter caído do scrollback bounded"
        );
    }

    #[test]
    fn color_survives_round_trip() {
        // feed de vermelho (\x1b[31m) → snapshot tem o SGR; 2º emulador re-parseando o
        // snapshot tem a mesma cor (fg vermelho) na célula.
        let mut e1 = TermEmulator::new(80, 24);
        e1.feed(b"\x1b[31mRED\x1b[0m");
        let snap = e1.snapshot(SCROLLBACK_LIMIT);
        assert!(
            snap.data.contains("\x1b[") && snap.data.contains("31"),
            "SGR de cor no snapshot: {:?}",
            snap.data
        );

        // Round-trip: alimenta o snapshot num 2º emulador e checa a célula.
        let mut e2 = TermEmulator::new(80, 24);
        e2.feed(snap.data.as_bytes());
        let c0 = cell_at(&e2, 0, 0); // 'R'
        assert_eq!(c0.c, 'R', "char round-trip");
        assert_eq!(
            c0.fg,
            Color::Named(NamedColor::Red),
            "cor fg vermelha sobrevive ao round-trip, foi {:?}",
            c0.fg
        );
    }

    #[test]
    fn bold_survives_round_trip() {
        let mut e1 = TermEmulator::new(80, 24);
        e1.feed(b"\x1b[1mB\x1b[0m");
        let snap = e1.snapshot(SCROLLBACK_LIMIT);
        let mut e2 = TermEmulator::new(80, 24);
        e2.feed(snap.data.as_bytes());
        let c = cell_at(&e2, 0, 0);
        assert!(
            c.flags.contains(Flags::BOLD),
            "bold sobrevive ao round-trip, flags {:?}",
            c.flags
        );
    }

    #[test]
    fn da1_query_produces_no_response_bytes() {
        // DA1 (\x1b[c) é uma query. Desde o backstop, o emulador PODE responder — mas a
        // resposta vai pro buffer de `take_pending_responses`, nunca pro grid. Este teste
        // trava exatamente isso: resposta de query não pode CONTAMINAR o snapshot, senão
        // o front re-hidrataria a view com bytes de protocolo virando lixo na tela.
        //  (a) feed de DA1 não panica e o seq incrementa normalmente;
        //  (b) o snapshot não contém a resposta DA (\x1b[?...c).
        let mut e = TermEmulator::new(80, 24);
        e.feed(b"\x1b[c");
        assert_eq!(
            e.seq(),
            1,
            "feed de query incrementa seq como qualquer chunk"
        );
        let snap = e.snapshot(SCROLLBACK_LIMIT);
        // Nenhuma resposta DA do tipo CSI ? ... c foi gerada pelo emulador.
        assert!(
            !snap.data.contains("\x1b[?1;2c") && !snap.data.contains("\x1b[?6c"),
            "emulador não deve emitir resposta de DA1: {:?}",
            snap.data
        );
    }

    #[test]
    fn resize_changes_snapshot_dims() {
        let mut e = TermEmulator::new(80, 24);
        e.feed(b"hello");
        e.resize(100, 40);
        let snap = e.snapshot(SCROLLBACK_LIMIT);
        assert_eq!(snap.cols, 100);
        assert_eq!(snap.rows, 40);
    }

    #[test]
    fn dsr_sempre_responde_cpr() {
        // Sem view anexada ninguem responde o CPR: a TUI espera e morre com codigo 1
        // depois de ~30s (bug real, Windows, v0.1.141). O backstop cobre essa janela.
        let mut e = TermEmulator::new(80, 24);
        e.feed(b"\x1b[6n");
        let resp = e.take_pending_responses();
        assert_eq!(
            resp.len(),
            1,
            "DSR sem view deve gerar exatamente uma resposta CPR"
        );
        assert!(
            resp[0].starts_with(b"\x1b["),
            "CPR comeca com CSI: {:?}",
            resp[0]
        );
        assert_eq!(
            resp[0].last().copied(),
            Some(b'R'),
            "CPR termina em R: {:?}",
            resp[0]
        );
    }

    #[test]
    fn backstop_reporta_dimensoes_atuais_apos_resize() {
        // CSI 18 t = "reporte o tamanho da área de texto em caracteres". As dims do
        // backstop são compartilhadas com o emulador; sem o update no `resize` ele
        // responderia pra sempre o tamanho de quando a sessão nasceu.
        let mut e = TermEmulator::new(80, 24);
        e.resize(120, 40);
        e.feed(b"\x1b[18t");
        let resp = e.take_pending_responses();
        assert_eq!(resp.len(), 1, "CSI 18t sem view deve gerar resposta");
        let txt = String::from_utf8_lossy(&resp[0]).to_string();
        assert!(
            txt.contains("40") && txt.contains("120"),
            "deve refletir 120x40, veio: {txt:?}"
        );
    }

    #[test]
    fn take_pending_responses_drena() {
        let mut e = TermEmulator::new(80, 24);
        e.feed(b"\x1b[6n");
        e.feed(b"\x1b[6n");
        assert_eq!(
            e.take_pending_responses().len(),
            2,
            "duas queries, duas respostas"
        );
        assert_eq!(
            e.take_pending_responses().len(),
            0,
            "segunda drenagem vem vazia"
        );
    }

    #[test]
    fn backend_responde_as_queries_que_sao_dele() {
        // Conjunto de queries que o backend deve responder sozinho.
        let queries: &[(&[u8], &str)] = &[
            (b"\x1b[6n", "DSR / CPR"),
            (b"\x1b[c", "DA1"),
            (b"\x1b[>c", "DA2"),
            (b"\x1b[18t", "tamanho em celulas"),
            (b"\x1b]10;?\x07", "OSC 10 foreground"),
            (b"\x1b]11;?\x07", "OSC 11 background"),
        ];

        for (bytes, nome) in queries {
            let mut e = TermEmulator::new(80, 24);
            e.feed(bytes);
            let respostas = e.take_pending_responses();
            assert!(
                !respostas.is_empty(),
                "o backend deveria responder a query '{}'",
                nome
            );

            if *nome == "DSR / CPR" {
                let ultima = respostas.last().expect("resposta deveria existir");
                assert!(
                    ultima.ends_with(b"R"),
                    "resposta ao DSR/CPR deveria terminar em 'R'"
                );
            }
        }
    }

    #[test]
    fn osc_10_e_11_respondem_a_cor_dinamica_e_reset_restabelece_o_tema() {
        let mut e = TermEmulator::new(80, 24);

        e.feed(b"\x1b]10;#123456\x07");
        assert!(
            e.take_pending_responses().is_empty(),
            "SET nao gera resposta"
        );
        e.feed(b"\x1b]10;?\x07");
        assert!(
            single_response(&e).contains("10;rgb:1212/3434/5656"),
            "OSC 10 deve refletir o foreground alterado",
        );

        e.feed(b"\x1b]11;#abcdef\x07");
        assert!(
            e.take_pending_responses().is_empty(),
            "SET nao gera resposta"
        );
        e.feed(b"\x1b]11;?\x07");
        assert!(
            single_response(&e).contains("11;rgb:abab/cdcd/efef"),
            "OSC 11 deve refletir o background alterado",
        );

        e.feed(b"\x1b]110\x07\x1b]111\x07");
        e.feed(b"\x1b]10;?\x07\x1b]11;?\x07");
        let responses = e.take_pending_responses();
        assert_eq!(responses.len(), 2);
        let fg = String::from_utf8_lossy(&responses[0]);
        let bg = String::from_utf8_lossy(&responses[1]);
        assert!(
            fg.contains("10;rgb:eded/eeee/f0f0"),
            "reset OSC 110: {fg:?}"
        );
        assert!(
            bg.contains("11;rgb:0a0a/1010/1414"),
            "reset OSC 111: {bg:?}"
        );
    }

    #[test]
    fn osc_set_e_query_no_mesmo_read_preservam_a_ordem() {
        let mut e = TermEmulator::new(80, 24);

        // Sem as fronteiras OSC, o listener responderia a cor inicial porque o espelho
        // so seria sincronizado depois do chunk inteiro.
        e.feed(b"\x1b]10;#123456\x07\x1b]10;?\x07");
        assert!(
            single_response(&e).contains("10;rgb:1212/3434/5656"),
            "a query posterior ao SET deve enxergar o novo foreground",
        );

        // A ordem inversa deve consultar o estado antigo e so entao aplicar o SET.
        e.feed(b"\x1b]11;?\x07\x1b]11;#abcdef\x07");
        assert!(
            single_response(&e).contains("11;rgb:0a0a/1010/1414"),
            "a query anterior ao SET deve enxergar o background antigo",
        );
        e.feed(b"\x1b]11;?\x07");
        assert!(single_response(&e).contains("11;rgb:abab/cdcd/efef"));
    }

    #[test]
    fn osc_partido_entre_reads_sincroniza_so_apos_o_terminador() {
        let mut e = TermEmulator::new(80, 24);

        // O read do PTY pode cortar inclusive o ST (ESC \\) ao meio.
        e.feed(b"\x1b]10;#12");
        e.feed(b"3456\x1b");
        e.feed(b"\\");
        e.feed(b"\x1b]10;?\x1b\\");

        assert!(
            single_response(&e).contains("10;rgb:1212/3434/5656"),
            "a máquina de estados deve sobreviver a qualquer fronteira de read",
        );
    }

    #[test]
    fn osc_empilhado_interpreta_cada_parametro_por_posicao() {
        let mut e = TermEmulator::new(80, 24);

        // OSC 10 empilha: parametro 0=foreground, 1=background.
        e.feed(b"\x1b]10;#123456;?\x07");
        assert!(
            single_response(&e).contains("11;rgb:0a0a/1010/1414"),
            "10;#cor;? consulta background, nao foreground",
        );
        e.feed(b"\x1b]10;?\x07");
        assert!(single_response(&e).contains("10;rgb:1212/3434/5656"));

        let mut e = TermEmulator::new(80, 24);
        e.feed(b"\x1b]10;?;#abcdef\x07");
        assert!(
            single_response(&e).contains("10;rgb:eded/eeee/f0f0"),
            "10;?;#cor consulta foreground e ainda aplica o SET do background",
        );
        e.feed(b"\x1b]11;?\x07");
        assert!(single_response(&e).contains("11;rgb:abab/cdcd/efef"));
    }

    #[test]
    fn osc_4_e_12_seguem_com_risco_aceito_no_eager_spawn() {
        // Com view montada o xterm responde. No eager-spawn nao existe xterm, portanto
        // estas queries ficam sem respondedor: risco aceito e EXPLICITO, nao resolvido.
        // O backend ignora porque nao possui paleta/cursor autoritativos para responder.
        let queries: &[(&[u8], &str)] = &[
            (b"\x1b]4;1;?\x07", "OSC 4 paleta"),
            (b"\x1b]12;?\x07", "OSC 12 cursor"),
        ];

        for (bytes, nome) in queries {
            let mut e = TermEmulator::new(80, 24);
            e.feed(bytes);
            let respostas = e.take_pending_responses();
            assert!(
                respostas.is_empty(),
                "o backend NAO deve responder a '{}' (risco aceito no eager-spawn)",
                nome
            );
        }
    }

    #[test]
    fn dsr_privado_e_respondido_pelo_backend() {
        // O vte NAO despacha `CSI ? .. n` (ansi.rs:1701 casa so `('n', [])`), entao o
        // backend detecta no stream e SINTETIZA o DECXCPR. Sem isto, no eager-spawn
        // (sem xterm montado) ninguem respondia e a TUI morria esperando — era o
        // defeito original sobrevivendo nesta sequencia.
        let mut e = TermEmulator::new(80, 24);
        e.feed(b"\x1b[?6n");
        let respostas = e.take_pending_responses();
        assert_eq!(
            respostas.len(),
            1,
            "DSR privado tem que ser respondido pelo backend"
        );
        let r = String::from_utf8_lossy(&respostas[0]).to_string();
        assert!(
            r.starts_with("\u{1b}[?") && r.ends_with('R'),
            "DECXCPR tem formato ESC [ ? linha ; coluna ; 1 R, veio: {r:?}"
        );
    }

    #[test]
    fn detecta_dsr_privado_em_um_chunk() {
        let mut detector = DetectorDsrPrivado::default();
        assert_eq!(detector.scan(b"\x1b[?6n"), 1);
    }

    #[test]
    fn detecta_dsr_privado_partido_entre_chunks() {
        let mut detector = DetectorDsrPrivado::default();
        let primeiro = detector.scan(b"\x1b[?");
        assert_eq!(
            primeiro, 0,
            "o prefixo sozinho ainda nao forma uma requisicao completa"
        );

        let segundo = detector.scan(b"6n");
        assert_eq!(
            segundo, 1,
            "sequencia partida entre chunks: o PTY entrega pedacos arbitrarios, \
             entao um contains() simples falharia neste caso real; a maquina de estados \
             persiste e detecta corretamente"
        );
    }

    #[test]
    fn nao_confunde_com_dectcem() {
        let mut detector = DetectorDsrPrivado::default();
        assert_eq!(
            detector.scan(b"\x1b[?25h"),
            0,
            "mostrar cursor (DECTCEM) nao e DSR"
        );
    }

    #[test]
    fn conta_multiplas_no_mesmo_chunk() {
        let mut detector = DetectorDsrPrivado::default();
        assert_eq!(detector.scan(b"\x1b[?6n\x1b[?6n"), 2);
    }

    #[test]
    fn texto_comum_nao_dispara() {
        let mut detector = DetectorDsrPrivado::default();
        assert_eq!(detector.scan(b"ola mundo\n"), 0);
    }

    #[test]
    fn esc_repetido_nao_quebra() {
        let mut detector = DetectorDsrPrivado::default();
        assert_eq!(detector.scan(b"\x1b\x1b[?6n"), 1);
    }
}
