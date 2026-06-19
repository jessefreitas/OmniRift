import { useState, type ReactNode } from "react";
import { AgentCanvas } from "./AgentCanvas";
import { ACCENT, PRODUCT_NAME, TAGLINE, REPO_URL } from "./theme";

/* OmniRift marketing landing — ported from the `Ensemble Landing.dc.html` design and
   adapted to the real product: cross-platform (Linux/Windows/macOS via Tauri + Rust),
   Floors = git worktrees (not APFS), open-source. Styling is inline for 1:1 fidelity. */

const MUTED = "#9A9AA2";
const DIM = "#6A6A72";

const LogoBars = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={(size * 18) / 18} viewBox="0 0 18 18" fill="none">
    <rect x="1" y="8" width="3" height="9" rx="1.5" fill="var(--ac)" />
    <rect x="7.5" y="2" width="3" height="15" rx="1.5" fill="var(--ac)" />
    <rect x="14" y="5" width="3" height="12" rx="1.5" fill="var(--ac)" />
  </svg>
);

const eyebrow: React.CSSProperties = {
  fontFamily: "'JetBrains Mono',monospace",
  fontSize: 12,
  letterSpacing: "2.5px",
  textTransform: "uppercase",
  color: "var(--ac)",
  textAlign: "center",
};

const h2: React.CSSProperties = {
  fontSize: "clamp(30px,4.4vw,48px)",
  fontWeight: 600,
  letterSpacing: "-1.4px",
  textAlign: "center",
  lineHeight: 1.06,
};

interface Feature {
  num: string;
  title: string;
  desc: string;
  icon: ReactNode;
}

const ICON_PROPS = {
  width: 26,
  height: 26,
  viewBox: "0 0 26 26",
  fill: "none",
  stroke: "var(--ac)",
  strokeWidth: 1.5,
} as const;

const FEATURES: Feature[] = [
  {
    num: "01",
    title: "Canvas infinito",
    desc: "Espaço 2D ilimitado com grade, minimapa e snapping magnético, acelerado por GPU (Pixi.js). Navegue, amplie e agrupe sem perder o panorama.",
    icon: (
      <svg {...ICON_PROPS}>
        <rect x="3" y="3" width="20" height="20" rx="3" />
        <path d="M3 10h20M10 3v20" />
      </svg>
    ),
  },
  {
    num: "02",
    title: "Agentes que conversam",
    desc: "Conecte dois terminais com um cabo e eles passam a delegar tarefas entre si — mesmo agentes de CLIs diferentes, via uma skill/MCP injetada.",
    icon: (
      <svg {...ICON_PROPS}>
        <circle cx="6" cy="6" r="3" />
        <circle cx="20" cy="20" r="3" />
        <path d="M8.3 8.3 17.7 17.7" />
      </svg>
    ),
  },
  {
    num: "03",
    title: "Andares",
    desc: "Branches git isolados como worktrees: cada andar tem terminal, branch e working tree próprios, com hooks de setup, run e teardown.",
    icon: (
      <svg {...ICON_PROPS}>
        <rect x="3" y="4" width="20" height="4" rx="1.5" />
        <rect x="3" y="11" width="20" height="4" rx="1.5" />
        <rect x="3" y="18" width="20" height="4" rx="1.5" />
      </svg>
    ),
  },
  {
    num: "04",
    title: "Portais",
    desc: "Navegadores embutidos no canvas. Conectados a um agente, viram automação: clicar, ler o DOM, tirar screenshots e executar JS.",
    icon: (
      <svg {...ICON_PROPS}>
        <rect x="3" y="4" width="20" height="16" rx="2.5" />
        <path d="M3 9h20" />
      </svg>
    ),
  },
  {
    num: "05",
    title: "Rotinas",
    desc: "Prompts agendados que rodam em intervalos: testes contínuos, monitoramento, scraping. Configure e esqueça.",
    icon: (
      <svg {...ICON_PROPS}>
        <circle cx="13" cy="13" r="9.5" />
        <path d="M13 7.5V13l3.5 2" />
      </svg>
    ),
  },
  {
    num: "06",
    title: "Privado por padrão",
    desc: "Zero telemetria, sem conta, tudo local. Config em JSON, notas em Markdown — seus arquivos continuam seus.",
    icon: (
      <svg {...ICON_PROPS}>
        <circle cx="13" cy="13" r="9.5" />
        <circle cx="13" cy="13" r="3.2" fill="var(--ac)" stroke="none" />
      </svg>
    ),
  },
];

interface Faq {
  q: string;
  a: string;
}

const FAQS: Faq[] = [
  {
    q: "Preciso criar uma conta?",
    a: "Não. Funciona 100% local, sem login e sem telemetria. Nada do seu trabalho sai da sua máquina.",
  },
  {
    q: "Com quais agentes de código funciona?",
    a: "Com qualquer CLI de agente — Claude Code, Codex, OpenCode e outros. O canvas é agnóstico: cada terminal é um shell completo rodando o agente que você quiser.",
  },
  {
    q: "Os agentes realmente conversam entre si?",
    a: "Sim. Conectar dois terminais com um cabo habilita comunicação real via uma skill/MCP injetada na CLI — mesmo entre agentes de fornecedores diferentes.",
  },
  {
    q: "O que são os Andares?",
    a: "Branches git isolados, criados como worktrees: cada andar tem terminal, branch e working tree próprios, com hooks de setup, run e teardown. Troque de contexto sem perder o contexto.",
  },
  {
    q: "Funciona no Windows e no Linux?",
    a: "Sim. OmniRift é multiplataforma — Linux, Windows e macOS — construído com Tauri 2 e um backend em Rust. É o equivalente open-source do conceito que nasceu no macOS.",
  },
  {
    q: "OmniRift é pago?",
    a: "OmniRift é open-source e gratuito para usar localmente. O plano Pro é um pagamento único (vitalício, sem assinatura) que apoia o desenvolvimento e libera recursos avançados em até 2 máquinas.",
  },
];

function NavLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} style={{ color: MUTED, textDecoration: "none", fontSize: 14, fontWeight: 500 }}>
      {children}
    </a>
  );
}

export function Landing() {
  const [open, setOpen] = useState(0);
  const [showFull, setShowFull] = useState(false);

  const rootStyle = {
    "--ac": ACCENT,
    width: "100%",
    background: "#0A0A0C",
    color: "#F3F3F4",
    fontFamily: "'Space Grotesk',system-ui,sans-serif",
    minHeight: "100vh",
    WebkitFontSmoothing: "antialiased",
  } as React.CSSProperties;

  return (
    <div style={rootStyle}>
      {/* ===== banner: beta de lançamento ===== */}
      <a
        href="https://wa.me/5553999034520?text=Quero%20uma%20vaga%20no%20beta%20de%20lan%C3%A7amento%20do%20OmniRift"
        target="_blank"
        rel="noreferrer"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          flexWrap: "wrap",
          padding: "10px 16px",
          background: "color-mix(in oklab, var(--ac) 16%, #0A0A0C)",
          borderBottom: "1px solid color-mix(in oklab, var(--ac) 32%, transparent)",
          color: "#F3F3F4",
          textDecoration: "none",
          fontSize: 14,
          fontWeight: 500,
          textAlign: "center",
        }}
      >
        <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, letterSpacing: "1.5px", textTransform: "uppercase", color: "var(--ac)", fontWeight: 700 }}>
          Beta de lançamento
        </span>
        <span>
          <b>50 vagas</b> · 60 dias grátis com <b>tudo liberado</b>
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--ac)", fontWeight: 700 }}>
          Garantir minha vaga →
        </span>
      </a>
      {/* ===== nav ===== */}
      <nav
        style={{
          position: "sticky",
          top: 0,
          zIndex: 50,
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          background: "rgba(10,10,12,.72)",
          borderBottom: "1px solid rgba(255,255,255,.07)",
        }}
      >
        <div
          style={{
            maxWidth: 1120,
            margin: "0 auto",
            padding: "13px 24px",
            display: "flex",
            alignItems: "center",
            gap: 20,
            flexWrap: "wrap",
          }}
        >
          <a
            href="#topo"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              color: "#F3F3F4",
              textDecoration: "none",
              fontWeight: 600,
              fontSize: 17,
              letterSpacing: "-.3px",
              marginRight: "auto",
            }}
          >
            <LogoBars />
            {PRODUCT_NAME}
          </a>
          <NavLink href="#recursos">Recursos</NavLink>
          <NavLink href="#precos">Preços</NavLink>
          <NavLink href="#faq">FAQ</NavLink>
          <a
            href="#precos"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              background: "#F3F3F4",
              color: "#0A0A0C",
              textDecoration: "none",
              padding: "9px 16px",
              borderRadius: 9,
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            Baixar
          </a>
        </div>
      </nav>

      {/* ===== hero ===== */}
      <header id="topo" style={{ position: "relative", overflow: "hidden", borderBottom: "1px solid rgba(255,255,255,.06)" }}>
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: -220,
            transform: "translateX(-50%)",
            width: 920,
            height: 520,
            background: "radial-gradient(closest-side, color-mix(in oklab, var(--ac) 15%, transparent), transparent)",
            filter: "blur(8px)",
            pointerEvents: "none",
          }}
        />
        <div style={{ position: "relative", maxWidth: 1120, margin: "0 auto", padding: "88px 24px 60px", textAlign: "center" }}>
          <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12, letterSpacing: "2.5px", textTransform: "uppercase", color: "var(--ac)", marginBottom: 26 }}>
            Orquestração visual de agentes
          </div>
          <h1 style={{ fontSize: "clamp(40px,6.4vw,74px)", fontWeight: 600, letterSpacing: "-2.4px", lineHeight: 1.02, margin: "0 0 24px", textWrap: "balance" }}>
            Um canvas para reger
            <br />
            seus agentes de IA.
          </h1>
          <p style={{ maxWidth: 560, margin: "0 auto 36px", fontSize: 19, lineHeight: 1.55, color: MUTED, textWrap: "pretty" }}>{TAGLINE}</p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <a
              href="#precos"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                background: "#F3F3F4",
                color: "#0A0A0C",
                textDecoration: "none",
                padding: "14px 24px",
                borderRadius: 11,
                fontWeight: 600,
                fontSize: 16,
              }}
            >
              Baixar grátis →
            </a>
            <button
              onClick={() => setShowFull(true)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                background: "transparent",
                color: "#F3F3F4",
                padding: "14px 24px",
                borderRadius: 11,
                fontWeight: 500,
                fontSize: 16,
                border: "1px solid rgba(255,255,255,.16)",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Abrir demo interativa →
            </button>
          </div>
          <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12.5, color: DIM, marginTop: 20, letterSpacing: ".3px" }}>
            Grátis para sempre · sem conta · 100% local
          </div>
        </div>

        {/* embedded interactive canvas */}
        <div style={{ maxWidth: 1100, margin: "0 auto", padding: "0 24px 80px" }}>
          <div
            style={{
              borderRadius: 18,
              border: "1px solid rgba(255,255,255,.1)",
              overflow: "hidden",
              boxShadow: "0 40px 90px -40px rgba(0,0,0,.85)",
              height: 600,
            }}
          >
            <AgentCanvas accent={ACCENT} productName={PRODUCT_NAME} embedded onOpenFull={() => setShowFull(true)} />
          </div>
        </div>
      </header>

      {/* ===== recursos ===== */}
      <section id="recursos" style={{ maxWidth: 1120, margin: "0 auto", padding: "96px 24px" }}>
        <div style={eyebrow}>Tudo no mesmo canvas</div>
        <h2 style={{ ...h2, margin: "14px auto 14px", maxWidth: 680, textWrap: "balance" }}>
          Você ama o terminal.
          <br />
          Mude tudo ao redor dele.
        </h2>
        <p style={{ textAlign: "center", color: MUTED, fontSize: 17, maxWidth: 540, margin: "0 auto 56px", textWrap: "pretty" }}>
          Pare de gerenciar pilhas de abas. Disponha agentes, notas e navegadores num espaço só — e deixe de ser o gargalo.
        </p>

        {/* Modo Maestro highlight */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 32,
            alignItems: "center",
            justifyContent: "space-between",
            border: "1px solid rgba(255,255,255,.09)",
            borderRadius: 20,
            padding: 40,
            background: "linear-gradient(180deg, rgba(20,20,23,.6), rgba(12,12,15,.6))",
            marginBottom: 24,
          }}
        >
          <div style={{ flex: 1, minWidth: 280 }}>
            <div
              style={{
                display: "inline-block",
                fontFamily: "'JetBrains Mono',monospace",
                fontSize: 11,
                letterSpacing: "1.5px",
                color: "var(--ac)",
                border: "1px solid color-mix(in oklab,var(--ac) 35%,transparent)",
                borderRadius: 6,
                padding: "4px 9px",
                marginBottom: 18,
              }}
            >
              MODO MAESTRO
            </div>
            <h3 style={{ fontSize: 27, fontWeight: 600, letterSpacing: "-.8px", margin: "0 0 12px", lineHeight: 1.15 }}>Promova um agente a gerente.</h3>
            <p style={{ color: MUTED, fontSize: 16, lineHeight: 1.6, margin: 0, maxWidth: 440, textWrap: "pretty" }}>
              Ele recruta, conecta e reatribui papéis sozinho — montando equipes de dev, revisor e testador sob demanda. Você só dá a direção.
            </p>
          </div>
          <div style={{ flexShrink: 0 }}>
            <svg width="240" height="170" viewBox="0 0 240 170" fill="none">
              <line x1="120" y1="85" x2="44" y2="36" stroke="var(--ac)" strokeOpacity=".5" strokeWidth="1.5" />
              <line x1="120" y1="85" x2="206" y2="40" stroke="var(--ac)" strokeOpacity=".5" strokeWidth="1.5" />
              <line x1="120" y1="85" x2="58" y2="138" stroke="var(--ac)" strokeOpacity=".5" strokeWidth="1.5" />
              <line x1="120" y1="85" x2="196" y2="134" stroke="var(--ac)" strokeOpacity=".5" strokeWidth="1.5" />
              <circle cx="44" cy="36" r="11" fill="#141417" stroke="rgba(255,255,255,.18)" />
              <circle cx="206" cy="40" r="11" fill="#141417" stroke="rgba(255,255,255,.18)" />
              <circle cx="58" cy="138" r="11" fill="#141417" stroke="rgba(255,255,255,.18)" />
              <circle cx="196" cy="134" r="11" fill="#141417" stroke="rgba(255,255,255,.18)" />
              <circle cx="120" cy="85" r="18" fill="color-mix(in oklab,var(--ac) 22%,#141417)" stroke="var(--ac)" strokeWidth="1.5" />
            </svg>
          </div>
        </div>

        {/* feature grid */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 20 }}>
          {FEATURES.map((f) => (
            <div
              key={f.num}
              style={{
                border: "1px solid rgba(255,255,255,.09)",
                borderRadius: 16,
                padding: 28,
                background: "rgba(20,20,23,.4)",
              }}
            >
              {f.icon}
              <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: DIM, margin: "16px 0 6px", letterSpacing: "1px" }}>{f.num}</div>
              <h4 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 8px", letterSpacing: "-.3px" }}>{f.title}</h4>
              <p style={{ color: MUTED, fontSize: 14.5, lineHeight: 1.55, margin: 0 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ===== preços ===== */}
      <section id="precos" style={{ borderTop: "1px solid rgba(255,255,255,.06)", background: "#0C0C0F" }}>
        <div style={{ maxWidth: 1120, margin: "0 auto", padding: "96px 24px" }}>
          <div style={eyebrow}>Preços</div>
          <h2 style={{ ...h2, margin: "14px auto 56px" }}>Simples. Sem surpresas.</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(290px,1fr))", gap: 22, maxWidth: 760, margin: "0 auto" }}>
            {/* free */}
            <div style={{ border: "1px solid rgba(255,255,255,.1)", borderRadius: 20, padding: 34, background: "rgba(20,20,23,.4)" }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: MUTED }}>Grátis</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "10px 0 4px" }}>
                <span style={{ fontSize: 46, fontWeight: 600, letterSpacing: "-1.5px" }}>R$0</span>
                <span style={{ color: DIM, fontSize: 15 }}>para sempre</span>
              </div>
              <a
                href="#"
                style={{
                  display: "flex",
                  justifyContent: "center",
                  background: "rgba(255,255,255,.07)",
                  color: "#F3F3F4",
                  textDecoration: "none",
                  padding: 13,
                  borderRadius: 11,
                  fontWeight: 600,
                  fontSize: 15,
                  margin: "22px 0",
                  border: "1px solid rgba(255,255,255,.12)",
                }}
              >
                Baixar grátis
              </a>
              <div style={{ display: "flex", flexDirection: "column", gap: 11, fontSize: 14.5, color: "#C9C9CF" }}>
                <div>1 workspace</div>
                <div>Agentes ilimitados</div>
                <div>Canvas infinito</div>
                <div>Notas, sketches e conexões</div>
                <div>Temas de terminal</div>
              </div>
            </div>
            {/* pro */}
            <div
              style={{
                border: "1.5px solid color-mix(in oklab,var(--ac) 55%,transparent)",
                borderRadius: 20,
                padding: 34,
                background: "linear-gradient(180deg, color-mix(in oklab,var(--ac) 7%,#141417), rgba(12,12,15,.5))",
                position: "relative",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: -11,
                  right: 24,
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 10,
                  letterSpacing: "1.5px",
                  background: "var(--ac)",
                  color: "#0A0A0C",
                  padding: "4px 10px",
                  borderRadius: 6,
                  fontWeight: 700,
                }}
              >
                VITALÍCIO
              </div>
              <div style={{ fontSize: 16, fontWeight: 600, color: "var(--ac)" }}>Pro</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "10px 0 4px" }}>
                <span style={{ fontSize: 46, fontWeight: 600, letterSpacing: "-1.5px" }}>R$95</span>
                <span style={{ color: DIM, fontSize: 15 }}>pagamento único</span>
              </div>
              <a
                href="#"
                style={{
                  display: "flex",
                  justifyContent: "center",
                  background: "#F3F3F4",
                  color: "#0A0A0C",
                  textDecoration: "none",
                  padding: 13,
                  borderRadius: 11,
                  fontWeight: 600,
                  fontSize: 15,
                  margin: "22px 0",
                }}
              >
                Quero o Pro
              </a>
              <div style={{ display: "flex", flexDirection: "column", gap: 11, fontSize: 14.5, color: "#C9C9CF" }}>
                <div style={{ color: MUTED }}>Tudo do Grátis, e mais:</div>
                <div>Workspaces ilimitados</div>
                <div>Andares (worktrees git)</div>
                <div>Rotinas agendadas</div>
                <div>SSH remoto</div>
                <div>Use em até 2 máquinas</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ===== faq ===== */}
      <section id="faq" style={{ borderTop: "1px solid rgba(255,255,255,.06)" }}>
        <div style={{ maxWidth: 760, margin: "0 auto", padding: "96px 24px" }}>
          <div style={eyebrow}>Perguntas frequentes</div>
          <h2 style={{ ...h2, margin: "14px auto 48px" }}>Antes de baixar.</h2>
          <div style={{ borderBottom: "1px solid rgba(255,255,255,.08)" }}>
            {FAQS.map((f, i) => {
              const isOpen = open === i;
              return (
                <div key={i} style={{ borderTop: "1px solid rgba(255,255,255,.08)" }}>
                  <button
                    onClick={() => setOpen(isOpen ? -1 : i)}
                    style={{
                      width: "100%",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 16,
                      padding: "22px 4px",
                      background: "none",
                      border: "none",
                      color: "#F3F3F4",
                      fontFamily: "inherit",
                      fontSize: 17.5,
                      fontWeight: 500,
                      textAlign: "left",
                      cursor: "pointer",
                    }}
                  >
                    <span style={{ textWrap: "balance" }}>{f.q}</span>
                    <span style={{ fontFamily: "'JetBrains Mono',monospace", color: "var(--ac)", fontSize: 22, flexShrink: 0, lineHeight: 1 }}>
                      {isOpen ? "–" : "+"}
                    </span>
                  </button>
                  {isOpen && (
                    <div style={{ padding: "0 4px 24px", color: MUTED, fontSize: 15.5, lineHeight: 1.62, maxWidth: 640, textWrap: "pretty" }}>{f.a}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ===== cta ===== */}
      <section style={{ borderTop: "1px solid rgba(255,255,255,.06)", position: "relative", overflow: "hidden" }}>
        <div
          style={{
            position: "absolute",
            left: "50%",
            bottom: -260,
            transform: "translateX(-50%)",
            width: 900,
            height: 520,
            background: "radial-gradient(closest-side, color-mix(in oklab,var(--ac) 14%,transparent), transparent)",
            filter: "blur(8px)",
            pointerEvents: "none",
          }}
        />
        <div style={{ position: "relative", maxWidth: 760, margin: "0 auto", padding: "104px 24px", textAlign: "center" }}>
          <h2 style={{ fontSize: "clamp(34px,5vw,56px)", fontWeight: 600, letterSpacing: "-1.8px", lineHeight: 1.04, margin: "0 0 20px", textWrap: "balance" }}>
            Pegue a batuta.
          </h2>
          <p style={{ color: MUTED, fontSize: 18, margin: "0 auto 34px", maxWidth: 480, textWrap: "pretty" }}>
            Seu novo runtime — não para o código, mas para você. Grátis para começar, em segundos.
          </p>
          <a
            href="#"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              background: "#F3F3F4",
              color: "#0A0A0C",
              textDecoration: "none",
              padding: "15px 28px",
              borderRadius: 12,
              fontWeight: 600,
              fontSize: 16,
            }}
          >
            Baixar {PRODUCT_NAME} →
          </a>
          <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12.5, color: DIM, marginTop: 18 }}>Linux · Windows · macOS · open-source</div>
        </div>
      </section>

      {/* ===== footer ===== */}
      <footer style={{ borderTop: "1px solid rgba(255,255,255,.07)", background: "#0C0C0F" }}>
        <div
          style={{
            maxWidth: 1120,
            margin: "0 auto",
            padding: "48px 24px",
            display: "flex",
            flexWrap: "wrap",
            gap: 32,
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 600, fontSize: 16 }}>
            <LogoBars size={16} />
            {PRODUCT_NAME}
          </div>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            <a href="#recursos" style={{ color: MUTED, textDecoration: "none", fontSize: 14 }}>
              Recursos
            </a>
            <a href="#precos" style={{ color: MUTED, textDecoration: "none", fontSize: 14 }}>
              Preços
            </a>
            <a href="#faq" style={{ color: MUTED, textDecoration: "none", fontSize: 14 }}>
              FAQ
            </a>
            <a href={REPO_URL} style={{ color: MUTED, textDecoration: "none", fontSize: 14 }}>
              Código
            </a>
            <a href="#" style={{ color: MUTED, textDecoration: "none", fontSize: 14 }}>
              Privacidade
            </a>
          </div>
          <div
            style={{
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 12,
              color: DIM,
              width: "100%",
              borderTop: "1px solid rgba(255,255,255,.06)",
              paddingTop: 24,
            }}
          >
            © 2026 {PRODUCT_NAME} · Open-source · Sem telemetria
          </div>
        </div>
      </footer>

      {/* ===== full-screen demo overlay ===== */}
      {showFull && (
        <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "#0A0A0C" }}>
          <AgentCanvas accent={ACCENT} productName={PRODUCT_NAME} onClose={() => setShowFull(false)} />
        </div>
      )}
    </div>
  );
}
