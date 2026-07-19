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
//!   xterm vê a query o backend já respondeu. Agora o xterm CONSOME as queries sem
//!   responder (`registerCsiHandler`) e a autoridade é só daqui — sem janela.
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

use serde::Serialize;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// Scrollback máximo retido pelo emulador (linhas). Bounded de propósito: um agente
/// em loop não pode pinnizar GBs no backend. A UI pode pedir uma janela menor ao
/// remontar uma view; o histórico maior continua disponível como fonte de verdade.
pub const SCROLLBACK_LIMIT: usize = 10_000;

/// Cap de segurança do snapshot serializado (bytes). Evita IPC gigante mesmo com
/// linhas largas/coloridas. ~4 MB cobre 10k linhas com SGR folgado.
pub const SNAPSHOT_MAX_BYTES: usize = 4 * 1024 * 1024;

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
/// É o ÚNICO respondedor — o xterm do front consome as queries sem responder.
#[derive(Clone)]
pub struct BackstopListener {
    pending: Arc<Mutex<Vec<Vec<u8>>>>,
    /// Compartilhado com o TermEmulator: o `resize` atualiza aqui, senão responderia
    /// TextAreaSizeRequest com o tamanho de quando a sessão nasceu.
    dims: Arc<Mutex<(u16, u16)>>,
}

/// Teto do buffer de respostas: se ninguém drenar (sessão morta), não crescemos sem
/// limite — descartamos em vez de segurar memória.
const MAX_PENDING_RESPONSES: usize = 256;

impl EventListener for BackstopListener {
    fn send_event(&self, event: Event) {
        let resposta = match event {
            Event::PtyWrite(s) => s,
            // Cor REAL do tema da view (useTerminalSession: bg #0a1014, fg #edeef0).
            // Responder preto pra tudo fazia o app calcular contraste em cima de uma
            // cor que não é a da tela — TUI escolhia paleta errada por achar o fundo
            // diferente do que é. Índice desconhecido cai no fundo, que é o palpite
            // menos danoso (a maioria pergunta OSC 11).
            Event::ColorRequest(idx, f) => {
                let cor = if idx == NamedColor::Foreground as usize {
                    Rgb { r: 0xed, g: 0xee, b: 0xf0 }
                } else {
                    Rgb { r: 0x0a, g: 0x10, b: 0x14 }
                };
                f(cor)
            }
            Event::TextAreaSizeRequest(f) => {
                let (cols, rows) = *self.dims.lock();
                // Célula em pixels não existe no backend (headless): 8x16 é o padrão de
                // facto. Só afeta quem pergunta o tamanho em PIXELS; em células (CSI 18t)
                // a resposta é exata.
                f(WindowSize { num_lines: rows, num_cols: cols, cell_width: 8, cell_height: 16 })
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

pub struct TermEmulator {
    term: Term<BackstopListener>,
    pending: Arc<Mutex<Vec<Vec<u8>>>>,
    /// Dimensões vistas pelo respondedor, atualizadas no `resize`.
    dims: Arc<Mutex<(u16, u16)>>,
    parser: Processor,
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
        let config = Config { scrolling_history: SCROLLBACK_LIMIT, ..Config::default() };
        let size = EmuSize { cols: cols as usize, rows: rows as usize };
        let pending = Arc::new(Mutex::new(Vec::new()));
        let dims = Arc::new(Mutex::new((cols, rows)));
        let listener = BackstopListener {
            pending: Arc::clone(&pending),
            dims: Arc::clone(&dims),
        };
        let term = Term::new(config, &size, listener);
        Self { term, parser: Processor::new(), seq, cols, rows, pending, dims }
    }

    /// Alimenta bytes do PTY no grid. `seq += 1` por chamada (1 chunk pintado). O
    /// `VoidListener` garante que nenhuma resposta de query saia daqui (só o grid muda).
    pub fn feed(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.term, bytes);
        self.seq.fetch_add(1, Ordering::SeqCst);
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
        self.term.resize(EmuSize { cols: cols as usize, rows: rows as usize });
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
        let history = if is_alt { 0 } else { grid.history_size().min(scrollback_rows) };
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

        PtySnapshot { data: out, cols: self.cols, rows: self.rows, seq: self.seq.load(Ordering::SeqCst) }
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

    /// Acha a célula `(line, col)` no grid re-parseado, pra checar cor/estilo round-trip.
    fn cell_at(emu: &TermEmulator, line: i32, col: usize) -> Cell {
        emu.term.grid()[Point::new(Line(line), Column(col))].clone()
    }

    #[test]
    fn feed_text_appears_in_snapshot() {
        let mut e = TermEmulator::new(80, 24);
        e.feed(b"foo\r\nbar");
        let snap = e.snapshot(SCROLLBACK_LIMIT);
        assert!(snap.data.contains("foo"), "snapshot deve conter foo: {:?}", snap.data);
        assert!(snap.data.contains("bar"), "snapshot deve conter bar: {:?}", snap.data);
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
        assert!(snap.data.contains("L19999"), "linha mais recente deve sobreviver");
        assert!(!snap.data.contains("L0\r\n"), "linha 0 deve ter caído do scrollback bounded");
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
        assert!(c.flags.contains(Flags::BOLD), "bold sobrevive ao round-trip, flags {:?}", c.flags);
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
        assert_eq!(e.seq(), 1, "feed de query incrementa seq como qualquer chunk");
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
        assert_eq!(resp.len(), 1, "DSR sem view deve gerar exatamente uma resposta CPR");
        assert!(resp[0].starts_with(b"\x1b["), "CPR comeca com CSI: {:?}", resp[0]);
        assert_eq!(resp[0].last().copied(), Some(b'R'), "CPR termina em R: {:?}", resp[0]);
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
        assert!(txt.contains("40") && txt.contains("120"), "deve refletir 120x40, veio: {txt:?}");
    }

    #[test]
    fn take_pending_responses_drena() {
        let mut e = TermEmulator::new(80, 24);
        e.feed(b"\x1b[6n");
        e.feed(b"\x1b[6n");
        assert_eq!(e.take_pending_responses().len(), 2, "duas queries, duas respostas");
        assert_eq!(e.take_pending_responses().len(), 0, "segunda drenagem vem vazia");
    }
}
