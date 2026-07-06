import { useState, type ReactNode } from "react";
import { AgentCanvas } from "./AgentCanvas";
import { ACCENT, PRODUCT_NAME, TAGLINE, REPO_URL } from "./theme";

/* OmniRift marketing landing — ported from the `Ensemble Landing.dc.html` design and
   adapted to the real product: cross-platform (Linux/Windows via Tauri + Rust),
   Floors = git worktrees (not APFS), open-source. Styling is inline for 1:1 fidelity. */

const MUTED = "#9A9AA2";
const DIM = "#6A6A72";

// License worker: /signup cria a licença trial + o link de checkout (cartão, 30min);
// /download/<so> faz 302 direto pro instalador mais novo do release.
const LICENSE_WORKER = "https://omnirift-license-worker.jesse-vieira-freitas.workers.dev";

// `?beta=1` (vem do CTA in-app do fim do beta) → checkout com desconto de beta tester.
const BETA_DISCOUNT = typeof location !== "undefined" && new URLSearchParams(location.search).has("beta");

// Download direto por SO: detecta o sistema e aponta pro /download do worker, que
// resolve o asset mais novo (linux→.AppImage, windows→.exe; mac/desconhecido→releases).
const DOWNLOAD_URL = (() => {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Windows/i.test(ua)) return `${LICENSE_WORKER}/download/windows`;
  if (/Linux/i.test(ua) && !/Android/i.test(ua)) return `${LICENSE_WORKER}/download/linux`;
  if (/Macintosh|Mac OS X/i.test(ua)) return `${LICENSE_WORKER}/download/mac`;
  return `${LICENSE_WORKER}/download`;
})();

// Fase de beta de lançamento: o card Pro vira CTA de "ser beta tester" (sem cobrança).
// Flip pra false quando começar a cobrar → volta o checkout Asaas (ProCheckout).
const BETA_LAUNCH = true;
const BETA_WA = "https://chat.whatsapp.com/D8jBZtQd70k2VponOHvETX";
// Doação: o worker /donate cria um checkout Asaas (R$10,90, pagamento único, SÓ PIX+cartão)
// e redireciona. paymentLink não restringe método; o checkout (billingTypes array) sim.
const DONATE_URL = `${LICENSE_WORKER}/donate`;

/** Cria a licença/checkout no worker e devolve o link de pagamento (ou lança). */
async function startCheckout(email: string, plan: "monthly" | "yearly"): Promise<string> {
  const res = await fetch(`${LICENSE_WORKER}/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: email.trim(), plan, betaDiscount: BETA_DISCOUNT }),
  });
  const data = (await res.json().catch(() => ({}))) as { checkoutLink?: string; error?: string };
  if (res.ok && data.checkoutLink) return data.checkoutLink;
  throw new Error(data.error || "Não foi possível iniciar o checkout.");
}

/** Form inline do card Pro: email + botões Mensal/Anual → redireciona pro checkout. */
function ProCheckout() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<null | "monthly" | "yearly">(null);
  const [err, setErr] = useState<string | null>(null);
  const go = async (plan: "monthly" | "yearly") => {
    setErr(null);
    if (!email.includes("@")) {
      setErr("Informe um email válido.");
      return;
    }
    setBusy(plan);
    try {
      window.location.href = await startCheckout(email, plan);
    } catch (e) {
      setErr((e as Error).message || "Falha de conexão. Tente novamente.");
      setBusy(null);
    }
  };
  const btn: React.CSSProperties = {
    flex: 1,
    cursor: "pointer",
    padding: 12,
    borderRadius: 10,
    fontWeight: 600,
    fontSize: 13.5,
    fontFamily: "inherit",
  };
  return (
    <div style={{ margin: "20px 0", display: "flex", flexDirection: "column", gap: 9 }}>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="seu@email.com"
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: 12,
          borderRadius: 10,
          border: "1px solid rgba(255,255,255,.14)",
          background: "rgba(0,0,0,.25)",
          color: "#F3F3F4",
          fontSize: 14.5,
          fontFamily: "inherit",
          outline: "none",
        }}
      />
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={() => go("monthly")}
          disabled={busy !== null}
          style={{ ...btn, border: "none", background: "#F3F3F4", color: "#0A0A0C", opacity: busy && busy !== "monthly" ? 0.5 : 1 }}
        >
          {busy === "monthly" ? "Indo pro pagamento…" : "Assinar · R$14,90/mês"}
        </button>
        <button
          onClick={() => go("yearly")}
          disabled={busy !== null}
          style={{ ...btn, border: "1px solid rgba(255,255,255,.18)", background: "transparent", color: "#F3F3F4", opacity: busy && busy !== "yearly" ? 0.5 : 1 }}
        >
          {busy === "yearly" ? "Indo pro pagamento…" : "Assinar · R$109,90/ano"}
        </button>
      </div>
      <div style={{ color: DIM, fontSize: 11.5, textAlign: "center" }}>→ checkout seguro no Asaas (cartão) · 7 dias grátis</div>
      {err && <div style={{ color: "#F38A8A", fontSize: 12.5 }}>{err}</div>}
    </div>
  );
}

// Marca OmniRift — "Fenda em Espiral" (conceito 03): dois arcos concêntricos em
// sentidos opostos + núcleo. Usa var(--ac) (accent teal) pra acompanhar o tema.
const Logo = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 100 100" fill="none" aria-hidden="true">
    <g stroke="var(--ac)" strokeLinecap="round" fill="none">
      <circle cx="50" cy="50" r="34" strokeWidth="7" strokeDasharray="150 64" transform="rotate(-90 50 50)" />
      <circle cx="50" cy="50" r="21" strokeWidth="7" strokeDasharray="95 37" transform="rotate(120 50 50)" />
    </g>
    <circle cx="50" cy="50" r="6" fill="var(--ac)" />
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
    title: "Paralelos = worktrees git",
    desc: "Cada paralelo é um worktree git de verdade — branch, working tree e terminal próprios. Toque várias frentes ao mesmo tempo, sem stash e sem trocar de branch. É git-native, não uma metáfora.",
    icon: (
      <svg {...ICON_PROPS}>
        <rect x="3" y="4" width="20" height="4" rx="1.5" />
        <rect x="3" y="11" width="20" height="4" rx="1.5" />
        <rect x="3" y="18" width="20" height="4" rx="1.5" />
      </svg>
    ),
  },
  {
    num: "02",
    title: "OmniPartner",
    desc: "Um copiloto que enxerga o canvas inteiro e a memória do projeto — com QUALQUER LLM: Claude, GPT, Ollama local, o que você trouxer (BYOK). Sem ficar preso a um modelo de um fabricante só.",
    icon: (
      <svg {...ICON_PROPS}>
        <circle cx="13" cy="13" r="9.5" />
        <circle cx="13" cy="13" r="3.2" fill="var(--ac)" stroke="none" />
      </svg>
    ),
  },
  {
    num: "03",
    title: "Agentes que conversam",
    desc: "Ligue dois terminais com um cabo e eles delegam tarefas entre si — mesmo agentes de CLIs diferentes (Claude Code, Codex…), via MCP injetado. O orquestrador despacha; os workers executam.",
    icon: (
      <svg {...ICON_PROPS}>
        <circle cx="6" cy="6" r="3" />
        <circle cx="20" cy="20" r="3" />
        <path d="M8.3 8.3 17.7 17.7" />
      </svg>
    ),
  },
  {
    num: "04",
    title: "OmniCompress nativo",
    desc: "Já vem ligado, cuidando dos seus tokens — comprime o contexto antes de chegar no modelo: menos custo, mesmo resultado. Pode desligar quando quiser, e somar RTK/Headroom por cima. Com painel de gasto por projeto.",
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M4 19a9 9 0 0 1 18 0" />
        <path d="M13 19l5.5-5.5" />
      </svg>
    ),
  },
  {
    num: "05",
    title: "Code Workspace",
    desc: "Editor Monaco direto no canvas, ao lado dos agentes. Abra, edite e salve arquivos sem sair do fluxo — o código e quem o escreve no mesmo lugar.",
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M9 8l-5 5 5 5" />
        <path d="M17 8l5 5-5 5" />
      </svg>
    ),
  },
  {
    num: "06",
    title: "Checkpoint invisível",
    desc: "Cada ação de agente vira um ponto de restauração automático. Errou? Volta o nó pro estado anterior com um clique — sem git, sem medo. Um versionador que trabalha nos bastidores enquanto você e os agentes tocam o projeto.",
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M13 3.5a9.5 9.5 0 1 1-8.7 5.6" />
        <path d="M4 3.5v5h5" />
        <path d="M13 8v5l3.5 2" />
      </svg>
    ),
  },
  {
    num: "07",
    title: "Comande do celular",
    desc: "Saiu da frente do PC e um agente pediu permissão? Aprove ou negue pelo celular, mova cards do Kanban e veja a frota inteira — de qualquer lugar, via 4G. O canvas segue rodando em casa; você só pilota.",
    icon: (
      <svg {...ICON_PROPS}>
        <rect x="7" y="2.5" width="12" height="21" rx="2.5" />
        <path d="M11 20h4" />
      </svg>
    ),
  },
  {
    num: "08",
    title: "Kanban que os agentes tocam",
    desc: "Um quadro de tarefas que os próprios agentes movem: puxam do backlog, marcam em progresso e entregam. Você acompanha o trabalho fluindo em tempo real — sem ficar perguntando “e aí, terminou?”.",
    icon: (
      <svg {...ICON_PROPS}>
        <rect x="3" y="4" width="5.5" height="18" rx="1.5" />
        <rect x="10.5" y="4" width="5.5" height="12" rx="1.5" />
        <rect x="18" y="4" width="5" height="8" rx="1.5" />
      </svg>
    ),
  },
  {
    num: "09",
    title: "Open-source, no seu sistema",
    desc: "Roda em Linux e Windows (Tauri 2 + Rust), código aberto e 100% offline: sem login, sem analytics, sem nuvem. Config e notas ficam em arquivos de texto no seu disco, abríveis em qualquer editor.",
    icon: (
      <svg {...ICON_PROPS}>
        <rect x="3" y="3" width="20" height="20" rx="3" />
        <path d="M3 10h20M10 3v20" />
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
    a: "Não pra usar local. A edição community roda sem login e sem rastreio — nada do seu trabalho sai da sua máquina. Conta só entra se você ativar o Pro (uma licença).",
  },
  {
    q: "Com quais agentes de código funciona?",
    a: "Com qualquer CLI de agente — Claude Code, Codex, OpenCode e outros. O canvas é agnóstico: cada terminal é um shell completo rodando o agente que você quiser. E o OmniPartner usa o LLM que você trouxer (BYOK).",
  },
  {
    q: "Os agentes realmente conversam entre si?",
    a: "Sim. Ligar dois terminais com um cabo habilita comunicação real via MCP injetado na CLI — mesmo entre agentes de fornecedores diferentes. Um vira orquestrador e despacha tarefas pros outros.",
  },
  {
    q: "O que são os Paralelos?",
    a: "Worktrees git de verdade: cada paralelo tem branch, working tree e terminal próprios, com hooks de setup, run e teardown. Toque várias frentes ao mesmo tempo — sem stash, sem trocar de branch.",
  },
  {
    q: "E se os agentes travarem ou se perderem?",
    a: "O OmniRift foi feito pra não travar em silêncio — e pra aprender. Cada agente captura os próprios erros→correções: se o mesmo erro voltar, ele já recebe o fix que funcionou antes (sem repetir a cilada). Um watchdog vigia a orquestração e cobra o líder sozinho se o time fica ocioso, te avisando se ainda assim empacar. A recitação mantém os agentes no rumo, e cada ação vira um checkpoint automático que você desfaz com um clique.",
  },
  {
    q: "Funciona no Windows e no Linux?",
    a: "Sim — OmniRift é feito pra Linux e Windows (Tauri 2 + Rust), open-source. É o canvas de orquestração pra quem desenvolve nesses sistemas; não é port de nada de outra plataforma.",
  },
  {
    q: "Quanto custa?",
    a: "A edição community é grátis e open-source (1 workspace; agentes e canvas ilimitados). O Pro libera workspaces ilimitados e uso em até 3 computadores — R$14,90/mês ou R$109,90/ano, com 7 dias grátis. No lançamento: beta com 50 vagas, tudo liberado por 60 dias.",
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
        href="https://chat.whatsapp.com/D8jBZtQd70k2VponOHvETX"
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
          💬 Entrar no grupo do WhatsApp →
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
            <Logo />
            {PRODUCT_NAME}
          </a>
          <NavLink href="#recursos">Recursos</NavLink>
          <NavLink href="#precos">Preços</NavLink>
          <NavLink href="#faq">FAQ</NavLink>
          <a href={REPO_URL} target="_blank" rel="noreferrer" style={{ color: MUTED, textDecoration: "none", fontSize: 14, fontWeight: 500 }}>GitHub</a>
          <a
            href="#baixar"
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
            Um canvas para orquestrar
            <br />
            seus agentes de IA.
          </h1>
          <p style={{ maxWidth: 560, margin: "0 auto 36px", fontSize: 19, lineHeight: 1.55, color: MUTED, textWrap: "pretty" }}>{TAGLINE}</p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <a
              href={DOWNLOAD_URL}
              target="_blank"
              rel="noreferrer"
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
            <a
              href={DONATE_URL}
              target="_blank"
              rel="noreferrer"
              title="Apoie o desenvolvimento (doação única via Asaas)"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                background: "transparent",
                color: "var(--ac)",
                textDecoration: "none",
                padding: "14px 24px",
                borderRadius: 11,
                fontWeight: 600,
                fontSize: 16,
                border: "1px solid color-mix(in oklab,var(--ac) 40%,transparent)",
              }}
            >
              ❤️ Apoiar · R$10,90
            </a>
          </div>
          <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12.5, color: DIM, marginTop: 20, letterSpacing: ".3px" }}>
            Open-source · sem conta · 100% local
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
          Monte seu ambiente.
          <br />
          Não gerencie abas.
        </h2>
        <p style={{ textAlign: "center", color: MUTED, fontSize: 17, maxWidth: 540, margin: "0 auto 56px", textWrap: "pretty" }}>
          Disponha terminais, paralelos, notas e navegadores num mesmo plano e enxergue todo o trabalho de uma vez — sem caçar janela.
        </p>

        {/* Modo Piloto highlight */}
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
              MODO PILOTO
            </div>
            <h3 style={{ fontSize: 27, fontWeight: 600, letterSpacing: "-.8px", margin: "0 0 12px", lineHeight: 1.15 }}>Promova um agente a orquestrador.</h3>
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

        {/* Confiabilidade highlight */}
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
            marginTop: 24,
          }}
        >
          <div style={{ flexShrink: 0, order: 0 }}>
            <svg width="220" height="170" viewBox="0 0 220 170" fill="none" aria-hidden="true">
              <path d="M110 26l40 14v34c0 30-20 50-40 60-20-10-40-30-40-60V40l40-14z" fill="color-mix(in oklab,var(--ac) 12%,#141417)" stroke="var(--ac)" strokeWidth="1.6" />
              <path d="M92 88l13 13 24-27" stroke="var(--ac)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
          </div>
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
              APRENDE COM OS ERROS · FEITO PRA NÃO TRAVAR
            </div>
            <h3 style={{ fontSize: 27, fontWeight: 600, letterSpacing: "-.8px", margin: "0 0 12px", lineHeight: 1.15 }}>Seus agentes não tropeçam duas vezes na mesma pedra.</h3>
            <p style={{ color: MUTED, fontSize: 16, lineHeight: 1.6, margin: 0, maxWidth: 470, textWrap: "pretty" }}>
              Todo agente captura os próprios erros: quando um comando falha e depois passa, a solução fica guardada — e se o mesmo tropeço volta, ele já recebe o fix conhecido pra não repetir a cilada (distinguindo palpite de correção confirmada). E se o time empaca, o watchdog cobra o líder sozinho e avisa <b style={{ color: "#F3F3F4" }}>você</b>. Local, privado, sem instalar nada — menos madrugada perdida.
            </p>
          </div>
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
                <span style={{ color: DIM, fontSize: 15 }}>open-source</span>
              </div>
              <a
                href={DOWNLOAD_URL}
                target="_blank"
                rel="noreferrer"
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
                <div>Agentes ilimitados · canvas infinito</div>
                <div>Paralelos ilimitados (worktrees git)</div>
                <div>Notas, sketches e conexões</div>
                <div>OmniPartner (BYO LLM) incluído</div>
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
                {BETA_LAUNCH ? "BETA · 60 DIAS GRÁTIS" : "7 DIAS GRÁTIS"}
              </div>
              <div style={{ fontSize: 16, fontWeight: 600, color: "var(--ac)" }}>Pro</div>
              {BETA_LAUNCH ? (
                <>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "10px 0 2px" }}>
                    <span style={{ fontSize: 46, fontWeight: 600, letterSpacing: "-1.5px" }}>Grátis</span>
                    <span style={{ color: DIM, fontSize: 15 }}>no beta · 60 dias</span>
                  </div>
                  <div style={{ color: DIM, fontSize: 13.5 }}>Beta de lançamento · 50 vagas · tudo liberado</div>
                  <a
                    href={BETA_WA}
                    target="_blank"
                    rel="noreferrer"
                    style={{ display: "block", textAlign: "center", background: "var(--ac)", color: "#0A0A0C", textDecoration: "none", padding: "13px 0", borderRadius: 11, fontWeight: 700, fontSize: 15, margin: "18px 0 6px" }}
                  >
                    💬 Entrar no grupo do WhatsApp →
                  </a>
                  <div style={{ color: DIM, fontSize: 12, textAlign: "center" }}>grupo de beta testers · suporte direto</div>
                </>
              ) : (
                <>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "10px 0 2px" }}>
                    <span style={{ fontSize: 46, fontWeight: 600, letterSpacing: "-1.5px" }}>R$14,90</span>
                    <span style={{ color: DIM, fontSize: 15 }}>/mês</span>
                  </div>
                  <div style={{ color: DIM, fontSize: 13.5 }}>ou R$109,90/ano (economize ~38%)</div>
                  <ProCheckout />
                </>
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 11, fontSize: 14.5, color: "#C9C9CF" }}>
                <div style={{ color: MUTED }}>Tudo do Grátis, e mais:</div>
                <div>Workspaces ilimitados</div>
                <div>Troca rápida entre workspaces</div>
                <div>Use em até 3 computadores</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ===== faq ===== */}
      <section id="baixar" style={{ borderTop: "1px solid rgba(255,255,255,.06)" }}>
        <div style={{ maxWidth: 1120, margin: "0 auto", padding: "96px 24px", textAlign: "center" }}>
          <div style={eyebrow}>Baixar</div>
          <h2 style={{ ...h2, margin: "14px auto 8px" }}>Pegue o OmniRift</h2>
          <p style={{ textAlign: "center", color: MUTED, fontSize: 17, maxWidth: 520, margin: "0 auto 44px" }}>
            Open-source · grátis · sem conta · roda no seu Linux, Windows ou macOS.
          </p>
          <div style={{ display: "flex", gap: 20, justifyContent: "center", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 260px", maxWidth: 320, border: "1px solid rgba(255,255,255,.09)", borderRadius: 16, padding: 28, background: "linear-gradient(180deg, rgba(20,20,23,.6), rgba(12,12,15,.6))", textAlign: "center" }}>
              <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>Linux</div>
              <div style={{ color: MUTED, fontSize: 13, marginBottom: 18 }}>.AppImage portátil</div>
              <a href={`${LICENSE_WORKER}/download/linux`} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "#F3F3F4", color: "#0A0A0C", textDecoration: "none", padding: "12px 22px", borderRadius: 10, fontWeight: 600, fontSize: 15 }}>
                Baixar para Linux →
              </a>
            </div>
            <div style={{ flex: "1 1 260px", maxWidth: 320, border: "1px solid rgba(255,255,255,.09)", borderRadius: 16, padding: 28, background: "linear-gradient(180deg, rgba(20,20,23,.6), rgba(12,12,15,.6))", textAlign: "center" }}>
              <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>Windows</div>
              <div style={{ color: MUTED, fontSize: 13, marginBottom: 18 }}>.exe instalador</div>
              <a href={`${LICENSE_WORKER}/download/windows`} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "#F3F3F4", color: "#0A0A0C", textDecoration: "none", padding: "12px 22px", borderRadius: 10, fontWeight: 600, fontSize: 15 }}>
                Baixar para Windows →
              </a>
            </div>
            <div style={{ flex: "1 1 260px", maxWidth: 320, border: "1px solid rgba(255,255,255,.09)", borderRadius: 16, padding: 28, background: "linear-gradient(180deg, rgba(20,20,23,.6), rgba(12,12,15,.6))", textAlign: "center" }}>
              <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>macOS</div>
              <div style={{ color: MUTED, fontSize: 13, marginBottom: 18 }}>.dmg · Apple Silicon</div>
              <a href={`${LICENSE_WORKER}/download/mac`} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "#F3F3F4", color: "#0A0A0C", textDecoration: "none", padding: "12px 22px", borderRadius: 10, fontWeight: 600, fontSize: 15 }}>
                Baixar para macOS →
              </a>
            </div>
          </div>
          <p style={{ color: MUTED, fontSize: 12.5, maxWidth: 460, margin: "22px auto 0" }}>
            macOS é não-assinado (uso pessoal): na 1ª vez, botão-direito no app → Abrir.
          </p>
          <a href="https://github.com/jessefreitas/OmniRift/releases/latest" target="_blank" rel="noreferrer" style={{ display: "inline-block", marginTop: 16, color: "var(--ac)", textDecoration: "none", fontSize: 14 }}>
            Todas as versões e formatos (.deb, .msi, .dmg) → GitHub Releases
          </a>
        </div>
      </section>

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
            Abra seu canvas.
          </h2>
          <p style={{ color: MUTED, fontSize: 18, margin: "0 auto 34px", maxWidth: 480, textWrap: "pretty" }}>
            Open-source, multiplataforma e 100% local. Baixe pronto ou clone o repositório e rode você mesmo — em segundos.
          </p>
          <a
            href={DOWNLOAD_URL}
            target="_blank"
            rel="noreferrer"
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
            <Logo size={16} />
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
            © 2026 {PRODUCT_NAME} · Open-source · multiplataforma
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
