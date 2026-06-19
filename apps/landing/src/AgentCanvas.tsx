import { useCallback, useEffect, useRef, useState } from "react";

/* Interactive agent canvas — a faithful React port of the `Canvas Ensemble.dc.html`
   prototype. Drag a node by its header, pull the accent `●` port onto another node
   to connect them, type a task + Enter in a terminal to get a scripted response that
   is forwarded to every connected peer. Drag the background to pan. */

type LineKind = "user" | "out" | "ok" | "warn" | "msg" | "sys";
interface Line {
  k: LineKind;
  t: string;
}
interface AgentNode {
  id: number;
  name: string;
  cli: string;
  llm: string;
  x: number;
  y: number;
  input: string;
  lines: Line[];
}
interface Edge {
  from: number;
  to: number;
}
interface Pt {
  x: number;
  y: number;
}
interface Inter {
  mode: "pan" | "drag" | "link" | null;
  dragId: number | null;
  off: Pt;
  linkFrom: number | null;
  panStart: Pt;
  panOrigin: Pt;
}

export interface AgentCanvasProps {
  accent: string;
  productName: string;
  /** true when rendered inside the hero (fills its container, hides the "site" link) */
  embedded?: boolean;
  /** shown in embedded mode — opens the full-screen demo */
  onOpenFull?: () => void;
  /** shown in full-screen mode — closes the overlay */
  onClose?: () => void;
}

const W = 308;
const PY = 120;
const HHIT = 252;

const CLIS = ["Claude Code", "Codex", "OpenCode", "Gemini CLI", "Aider"];
const LLMS = [
  "Claude Sonnet 4.5",
  "Claude Opus 4.1",
  "GPT-5",
  "GPT-5 mini",
  "Gemini 2.5 Pro",
  "Llama 4",
];

const LINE_COLOR: Record<LineKind, string> = {
  user: "#D4D4D8",
  out: "#9A9AA2",
  ok: "var(--ac)",
  warn: "#F6C667",
  msg: "var(--ac)",
  sys: "#6A6A72",
};
const LINE_PREFIX: Record<LineKind, string> = {
  user: "› ",
  out: "",
  ok: "✓ ",
  warn: "! ",
  msg: "‹ ",
  sys: "",
};

function respond(text: string): Line[] {
  const t = text.toLowerCase();
  if (/test|teste/.test(t))
    return [
      { k: "out", t: "rodando suíte de testes…" },
      { k: "ok", t: "12 testes passando" },
    ];
  if (/bug|erro|corrig|fix/.test(t))
    return [
      { k: "out", t: "investigando stack trace…" },
      { k: "warn", t: "1 edge case encontrado" },
      { k: "out", t: "aplicando correção" },
    ];
  if (/commit|merge|push|deploy/.test(t))
    return [
      { k: "out", t: "preparando alterações…" },
      { k: "ok", t: "feito no andar atual" },
    ];
  if (/revis|review|checa|diff/.test(t))
    return [
      { k: "out", t: "lendo o diff…" },
      { k: "ok", t: "aprovado, 2 comentários" },
    ];
  if (/conect|fala|pergunt|delega|pede/.test(t))
    return [{ k: "out", t: "falando com os agentes conectados…" }];
  return [
    { k: "out", t: "executando: " + text },
    { k: "ok", t: "concluído" },
  ];
}

function initialNodes(): AgentNode[] {
  return [
    {
      id: 1,
      name: "Líder",
      cli: "Claude Code",
      llm: "Claude Opus 4.1",
      x: 150,
      y: 110,
      input: "",
      lines: [
        { k: "user", t: "recrutar dev e revisor" },
        { k: "out", t: "equipe montada no canvas" },
        { k: "ok", t: "pronto" },
      ],
    },
    {
      id: 2,
      name: "Desenvolvedor",
      cli: "Codex",
      llm: "GPT-5",
      x: 600,
      y: 320,
      input: "",
      lines: [{ k: "out", t: "aguardando tarefa do líder…" }],
    },
  ];
}

const stop = (e: React.MouseEvent) => e.stopPropagation();
const dot = (c: string): React.CSSProperties => ({
  width: 8,
  height: 8,
  borderRadius: "50%",
  background: c,
});
const selStyle = (color: string): React.CSSProperties => ({
  flex: 1,
  minWidth: 0,
  background: "#1a1a1e",
  border: "1px solid rgba(255,255,255,.1)",
  color,
  fontFamily: "'JetBrains Mono',monospace",
  fontSize: 10.5,
  borderRadius: 7,
  padding: "5px 6px",
  outline: "none",
  cursor: "pointer",
});

export function AgentCanvas({
  accent,
  productName,
  embedded = false,
  onOpenFull,
  onClose,
}: AgentCanvasProps) {
  const [nodes, setNodes] = useState<AgentNode[]>(initialNodes);
  const [edges, setEdges] = useState<Edge[]>([{ from: 1, to: 2 }]);
  const [pan, setPan] = useState<Pt>({ x: 0, y: 0 });
  const [linkLine, setLinkLine] = useState<{ start: Pt; pos: Pt } | null>(null);

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const bodiesRef = useRef<Record<number, HTMLDivElement | null>>({});
  const interRef = useRef<Inter>({
    mode: null,
    dragId: null,
    off: { x: 0, y: 0 },
    linkFrom: null,
    panStart: { x: 0, y: 0 },
    panOrigin: { x: 0, y: 0 },
  });
  const nextIdRef = useRef(3);
  const scrollIdRef = useRef<number | null>(null);
  // mirror of render state so the window listeners always read fresh values
  const latestRef = useRef({ nodes, edges, pan });
  latestRef.current = { nodes, edges, pan };

  const world = useCallback((clientX: number, clientY: number): Pt => {
    const el = surfaceRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    const p = latestRef.current.pan;
    return { x: clientX - r.left - p.x, y: clientY - r.top - p.y };
  }, []);

  const addEdge = useCallback((a: number, b: number) => {
    if (a === b) return;
    setEdges((es) =>
      es.some((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a))
        ? es
        : [...es, { from: a, to: b }],
    );
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const it = interRef.current;
      if (!it.mode) return;
      if (it.mode === "pan") {
        setPan({
          x: it.panOrigin.x + (e.clientX - it.panStart.x),
          y: it.panOrigin.y + (e.clientY - it.panStart.y),
        });
        return;
      }
      const w = world(e.clientX, e.clientY);
      if (it.mode === "drag") {
        const off = it.off;
        setNodes((ns) =>
          ns.map((n) =>
            n.id === it.dragId ? { ...n, x: w.x - off.x, y: w.y - off.y } : n,
          ),
        );
      } else if (it.mode === "link") {
        setLinkLine((l) => (l ? { ...l, pos: w } : l));
      }
    };
    const onUp = (e: MouseEvent) => {
      const it = interRef.current;
      if (it.mode === "link" && it.linkFrom != null) {
        const w = world(e.clientX, e.clientY);
        const target = latestRef.current.nodes.find(
          (n) =>
            n.id !== it.linkFrom &&
            w.x >= n.x &&
            w.x <= n.x + W &&
            w.y >= n.y &&
            w.y <= n.y + HHIT,
        );
        if (target) addEdge(it.linkFrom, target.id);
      }
      if (it.mode) {
        it.mode = null;
        it.dragId = null;
        it.linkFrom = null;
        setLinkLine(null);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [world, addEdge]);

  useEffect(() => {
    if (scrollIdRef.current != null) {
      const el = bodiesRef.current[scrollIdRef.current];
      if (el) el.scrollTop = el.scrollHeight;
      scrollIdRef.current = null;
    }
  }, [nodes]);

  const onBgDown = (e: React.MouseEvent) => {
    interRef.current.mode = "pan";
    interRef.current.panStart = { x: e.clientX, y: e.clientY };
    interRef.current.panOrigin = { ...latestRef.current.pan };
  };

  const startDrag = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const w = world(e.clientX, e.clientY);
    const n = latestRef.current.nodes.find((x) => x.id === id);
    if (!n) return;
    interRef.current.mode = "drag";
    interRef.current.dragId = id;
    interRef.current.off = { x: w.x - n.x, y: w.y - n.y };
  };

  const startLink = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const n = latestRef.current.nodes.find((x) => x.id === id);
    if (!n) return;
    const s = { x: n.x + W, y: n.y + PY };
    interRef.current.mode = "link";
    interRef.current.linkFrom = id;
    setLinkLine({ start: s, pos: s });
  };

  const patch = (id: number, fields: Partial<AgentNode>) =>
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, ...fields } : n)));

  const deleteNode = (id: number) => {
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.from !== id && e.to !== id));
  };

  const addAgent = () => {
    const el = surfaceRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const p = latestRef.current.pan;
    const cx = -p.x + r.width / 2 - W / 2 + (Math.random() * 80 - 40);
    const cy = -p.y + r.height / 2 - 130 + (Math.random() * 60 - 30);
    const id = nextIdRef.current++;
    setNodes((ns) => [
      ...ns,
      {
        id,
        name: "Agente " + id,
        cli: "Claude Code",
        llm: "Claude Sonnet 4.5",
        x: cx,
        y: cy,
        input: "",
        lines: [{ k: "out", t: "shell pronto · claude" }],
      },
    ]);
  };

  const submit = (id: number) => {
    const cur = latestRef.current.nodes.find((x) => x.id === id);
    if (!cur) return;
    const text = (cur.input || "").trim();
    if (!text) return;
    const resp = respond(text);
    const peerIds = latestRef.current.edges
      .filter((e) => e.from === id || e.to === id)
      .map((e) => (e.from === id ? e.to : e.from));
    const extra: Line[] = peerIds.length
      ? [{ k: "sys", t: "→ encaminhado p/ " + peerIds.length + " conectado(s)" }]
      : [];
    setNodes((ns) =>
      ns.map((x) => {
        if (x.id === id)
          return {
            ...x,
            input: "",
            lines: [...x.lines, { k: "user", t: text }, ...resp, ...extra],
          };
        if (peerIds.includes(x.id))
          return {
            ...x,
            lines: [
              ...x.lines,
              { k: "msg", t: cur.name + ": " + text },
              { k: "ok", t: "recebido" },
            ],
          };
        return x;
      }),
    );
    scrollIdRef.current = id;
  };

  const removeEdge = (i: number) => setEdges((es) => es.filter((_, j) => j !== i));

  // build bezier paths for every edge (index preserved so removeEdge stays correct)
  const edgePaths = edges
    .map((e, i) => {
      const f = nodes.find((n) => n.id === e.from);
      const t = nodes.find((n) => n.id === e.to);
      if (!f || !t) return null;
      const sx = f.x + W,
        sy = f.y + PY,
        tx = t.x,
        ty = t.y + PY;
      const dx = Math.max(50, Math.abs(tx - sx) / 2);
      return {
        i,
        d: `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`,
      };
    })
    .filter((x): x is { i: number; d: string } => x !== null);

  let tempD = "";
  if (linkLine) {
    const s = linkLine.start,
      p = linkLine.pos;
    const dx = Math.max(50, Math.abs(p.x - s.x) / 2);
    tempD = `M ${s.x} ${s.y} C ${s.x + dx} ${s.y}, ${p.x - dx} ${p.y}, ${p.x} ${p.y}`;
  }

  const rootStyle = {
    "--ac": accent,
    height: embedded ? "100%" : "100vh",
    display: "flex",
    flexDirection: "column",
    background: "#0A0A0C",
    color: "#F3F3F4",
    fontFamily: "'Space Grotesk',system-ui,sans-serif",
    WebkitFontSmoothing: "antialiased",
    overflow: "hidden",
  } as React.CSSProperties;

  return (
    <div style={rootStyle}>
      {/* toolbar */}
      <div
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "11px 18px",
          borderBottom: "1px solid rgba(255,255,255,.08)",
          background: "rgba(12,12,15,.85)",
          zIndex: 10,
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontWeight: 600,
            fontSize: 16,
            letterSpacing: "-.3px",
          }}
        >
          <svg width="17" height="17" viewBox="0 0 18 18" fill="none">
            <rect x="1" y="8" width="3" height="9" rx="1.5" fill="var(--ac)" />
            <rect x="7.5" y="2" width="3" height="15" rx="1.5" fill="var(--ac)" />
            <rect x="14" y="5" width="3" height="12" rx="1.5" fill="var(--ac)" />
          </svg>
          {productName} <span style={{ color: "#5a5a62", fontWeight: 400 }}>· canvas</span>
        </div>
        <button
          onClick={addAgent}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            background: "#F3F3F4",
            color: "#0A0A0C",
            border: "none",
            padding: "8px 15px",
            borderRadius: 9,
            fontFamily: "inherit",
            fontWeight: 600,
            fontSize: 13.5,
            cursor: "pointer",
          }}
        >
          + Agente
        </button>
        <div
          style={{
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 11.5,
            color: "#6A6A72",
            letterSpacing: ".2px",
          }}
        >
          arraste o <span style={{ color: "#9A9AA2" }}>topo</span> p/ mover · puxe o{" "}
          <span style={{ color: "var(--ac)" }}>●</span> p/ conectar · arraste o{" "}
          <span style={{ color: "#9A9AA2" }}>fundo</span> p/ navegar
        </div>
        <div
          style={{
            marginLeft: "auto",
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 11.5,
            color: "#6A6A72",
          }}
        >
          {nodes.length} agentes
        </div>
        {onClose ? (
          <button
            onClick={onClose}
            style={{
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 11.5,
              color: "#9A9AA2",
              background: "transparent",
              border: "1px solid rgba(255,255,255,.14)",
              padding: "6px 11px",
              borderRadius: 8,
              cursor: "pointer",
            }}
          >
            ✕ fechar
          </button>
        ) : embedded && onOpenFull ? (
          <button
            onClick={onOpenFull}
            style={{
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 11.5,
              color: "#9A9AA2",
              background: "transparent",
              border: "1px solid rgba(255,255,255,.14)",
              padding: "6px 11px",
              borderRadius: 8,
              cursor: "pointer",
            }}
          >
            ⤢ tela cheia
          </button>
        ) : null}
      </div>

      {/* surface */}
      <div ref={surfaceRef} style={{ position: "relative", flex: 1, overflow: "hidden" }}>
        <div style={{ position: "absolute", left: 0, top: 0, transform: `translate(${pan.x}px, ${pan.y}px)` }}>
          {/* draggable grid background */}
          <div
            onMouseDown={onBgDown}
            style={{
              position: "absolute",
              left: -3000,
              top: -3000,
              width: 6000,
              height: 6000,
              backgroundImage: "radial-gradient(rgba(255,255,255,.055) 1px, transparent 1px)",
              backgroundSize: "24px 24px",
              cursor: "grab",
            }}
          />

          {/* connection cables */}
          <svg
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: 1,
              height: 1,
              overflow: "visible",
              pointerEvents: "none",
            }}
          >
            {edgePaths.map((ep) => (
              <g key={ep.i}>
                <path d={ep.d} fill="none" stroke="var(--ac)" strokeOpacity="0.5" strokeWidth="2" />
                <path
                  d={ep.d}
                  className="edge-flow"
                  fill="none"
                  stroke="var(--ac)"
                  strokeWidth="2"
                  strokeDasharray="2 10"
                  strokeLinecap="round"
                  strokeOpacity="0.95"
                />
                <path
                  d={ep.d}
                  fill="none"
                  stroke="rgba(0,0,0,0)"
                  strokeWidth="18"
                  style={{ pointerEvents: "stroke", cursor: "pointer" }}
                  onClick={() => removeEdge(ep.i)}
                />
              </g>
            ))}
            {linkLine && (
              <path d={tempD} fill="none" stroke="var(--ac)" strokeWidth="2" strokeDasharray="5 6" />
            )}
          </svg>

          {/* agent nodes */}
          {nodes.map((n) => (
            <div
              key={n.id}
              style={{
                position: "absolute",
                left: n.x,
                top: n.y,
                width: W,
                background: "#141417",
                border: "1px solid rgba(255,255,255,.1)",
                borderRadius: 13,
                boxShadow: "0 22px 52px -18px rgba(0,0,0,.75)",
              }}
            >
              {/* output port (pull to connect) + pulse ring */}
              <div
                onMouseDown={(e) => startLink(n.id, e)}
                title="Arraste para outro agente"
                style={{
                  position: "absolute",
                  right: -7,
                  top: PY,
                  transform: "translateY(-50%)",
                  width: 15,
                  height: 15,
                  borderRadius: "50%",
                  background: "var(--ac)",
                  border: "2px solid #0A0A0C",
                  cursor: "crosshair",
                  zIndex: 4,
                }}
              >
                <span
                  className="port-pulse"
                  style={{
                    position: "absolute",
                    inset: -2,
                    borderRadius: "50%",
                    background: "var(--ac)",
                    pointerEvents: "none",
                  }}
                />
              </div>
              {/* input port */}
              <div
                style={{
                  position: "absolute",
                  left: -6,
                  top: PY,
                  transform: "translateY(-50%)",
                  width: 12,
                  height: 12,
                  borderRadius: "50%",
                  background: "#2a2a30",
                  border: "2px solid #0A0A0C",
                  zIndex: 4,
                }}
              />

              {/* header */}
              <div
                onMouseDown={(e) => startDrag(n.id, e)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "9px 11px",
                  borderBottom: "1px solid rgba(255,255,255,.07)",
                  cursor: "grab",
                }}
              >
                <span style={{ display: "flex", gap: 5, flexShrink: 0 }}>
                  <span style={dot("#ff5f57")} />
                  <span style={dot("#febc2e")} />
                  <span style={dot("#28c840")} />
                </span>
                <input
                  value={n.name}
                  onChange={(e) => patch(n.id, { name: e.target.value })}
                  onMouseDown={stop}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    background: "transparent",
                    border: "none",
                    color: "#F3F3F4",
                    fontFamily: "inherit",
                    fontWeight: 600,
                    fontSize: 13.5,
                    outline: "none",
                    cursor: "text",
                    padding: "2px 4px",
                    borderRadius: 5,
                  }}
                />
                <button
                  onClick={() => deleteNode(n.id)}
                  onMouseDown={stop}
                  title="Remover"
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "#5a5a62",
                    fontSize: 18,
                    lineHeight: 1,
                    cursor: "pointer",
                    padding: "0 3px",
                  }}
                >
                  ×
                </button>
              </div>

              {/* CLI + LLM selects */}
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  padding: "8px 11px",
                  borderBottom: "1px solid rgba(255,255,255,.06)",
                }}
              >
                <select
                  className="cv-sel"
                  value={n.cli}
                  onChange={(e) => patch(n.id, { cli: e.target.value })}
                  onMouseDown={stop}
                  style={selStyle("#C9C9CF")}
                >
                  {CLIS.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
                <select
                  className="cv-sel"
                  value={n.llm}
                  onChange={(e) => patch(n.id, { llm: e.target.value })}
                  onMouseDown={stop}
                  style={selStyle("var(--ac)")}
                >
                  {LLMS.map((l) => (
                    <option key={l}>{l}</option>
                  ))}
                </select>
              </div>

              {/* terminal body */}
              <div
                ref={(el) => {
                  bodiesRef.current[n.id] = el;
                }}
                className="cv-body"
                style={{
                  height: 130,
                  overflowY: "auto",
                  padding: "10px 12px",
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 11.5,
                  lineHeight: 1.65,
                }}
              >
                {n.lines.map((ln, idx) => (
                  <div
                    key={idx}
                    style={{
                      color: LINE_COLOR[ln.k],
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      marginBottom: 1,
                    }}
                  >
                    {LINE_PREFIX[ln.k] + ln.t}
                  </div>
                ))}
              </div>

              {/* prompt input */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  padding: "8px 12px",
                  borderTop: "1px solid rgba(255,255,255,.07)",
                }}
              >
                <span
                  style={{
                    color: "var(--ac)",
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: 12,
                  }}
                >
                  $
                </span>
                <input
                  value={n.input}
                  onChange={(e) => patch(n.id, { input: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submit(n.id);
                  }}
                  onMouseDown={stop}
                  placeholder="digite uma tarefa e Enter…"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    background: "transparent",
                    border: "none",
                    outline: "none",
                    color: "#F3F3F4",
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: 12,
                    cursor: "text",
                  }}
                />
              </div>
            </div>
          ))}
        </div>

        {/* hint chip */}
        <div
          style={{
            position: "absolute",
            left: 18,
            bottom: 16,
            display: "flex",
            gap: 8,
            alignItems: "center",
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 10.5,
            color: "#5a5a62",
            pointerEvents: "none",
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: "rgba(20,20,23,.7)",
              border: "1px solid rgba(255,255,255,.08)",
              padding: "5px 9px",
              borderRadius: 7,
            }}
          >
            clique numa conexão para removê-la
          </span>
        </div>
      </div>
    </div>
  );
}
