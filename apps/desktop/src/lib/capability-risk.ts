// src/lib/capability-risk.ts
//
// LURKR-style: scan de RISCO DE CAPABILITY do que o OmniRift entrega a um agente. Um app que
// roda agentes com acesso a filesystem/shell/MCP tem 3 vetores de risco que o gate de código
// (gitleaks/semgrep no local-review.py) NÃO cobre — eles olham o diff, não o CONTEXTO vivo:
//   (1) credencial vazando no contexto (brief/persona/AGENTS.md → viaja pro LLM cloud);
//   (2) MCP não-verificado (servidor plugado fora de um allowlist conhecido);
//   (3) shadow capability (tool cujo nome denuncia poder destrutivo/exfiltração: shell, write, fetch…).
// Função PURA/testável. Os padrões de secret ESPELHAM scripts/local-review.py (41-44) pra o app e
// o gate falarem a mesma língua. NUNCA expõe o segredo cru — só um trecho redigido.

export type RiskSeverity = "info" | "warn" | "critical";

export interface RiskFinding {
  kind: "secret" | "mcp-unverified" | "shadow-capability";
  severity: RiskSeverity;
  /** O que é (rótulo curto). */
  label: string;
  /** Onde/qual (fonte legível — ex.: "brief", "MCP \"foo\""). */
  detail: string;
  /** Trecho MASCARADO do match — nunca o valor cru. */
  redacted?: string;
}

// Espelha scripts/local-review.py (linhas 41-44) + tokens comuns. `critical` = credencial
// inequívoca; `warn` = padrão heurístico (pode ter falso-positivo, mas vale o alerta).
const SECRET_PATTERNS: { label: string; re: RegExp; severity: RiskSeverity }[] = [
  { label: "chave privada", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, severity: "critical" },
  { label: "AWS access key", re: /AKIA[0-9A-Z]{16}/g, severity: "critical" },
  { label: "token estilo OpenAI", re: /sk-[A-Za-z0-9]{20,}/g, severity: "critical" },
  { label: "token GitHub", re: /gh[posu]_[A-Za-z0-9]{36,}/g, severity: "critical" },
  { label: "token Slack", re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, severity: "critical" },
  { label: "secret hardcoded", re: /(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"][^'"]{8,}['"]/gi, severity: "warn" },
];

/** Mascara um segredo pra logar sem vazar: 4 chars + reticências + bolinhas. */
export function redactSecret(s: string): string {
  if (s.length <= 8) return "•".repeat(s.length);
  return s.slice(0, 4) + "…" + "•".repeat(6);
}

/** Procura credenciais num pedaço de contexto (brief/persona/prompt). Dedupa por padrão+trecho. */
export function scanTextForSecrets(text: string, source: string): RiskFinding[] {
  const out: RiskFinding[] = [];
  const seen = new Set<string>();
  for (const p of SECRET_PATTERNS) {
    const matches = text.match(p.re);
    if (!matches) continue;
    for (const m of matches) {
      const red = redactSecret(m);
      const key = p.label + "|" + red;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: "secret", severity: p.severity, label: p.label, detail: source, redacted: red });
    }
  }
  return out;
}

// Tool cujo NOME denuncia poder destrutivo ou de exfiltração. Segmento (não substring solta):
// pega `run_shell`, `write_file`, `http_fetch` — não pega `preview` por causa do "view".
const DANGEROUS_TOOL_RE =
  /(?:^|[_-])(shell|exec|command|spawn|kill|write|delete|remove|unlink|rmdir|fetch|http|request|upload|curl|env|secret|credential)(?:$|[_-])/i;

export interface McpServerInfo {
  name: string;
  tools: string[];
}

/** Sinaliza MCP fora do allowlist (não-verificado) e tools de capability sensível. */
export function scanMcpServers(servers: McpServerInfo[], allowlist: string[]): RiskFinding[] {
  const allow = new Set(allowlist.map((s) => s.toLowerCase()));
  const out: RiskFinding[] = [];
  for (const s of servers) {
    if (!allow.has(s.name.toLowerCase())) {
      out.push({ kind: "mcp-unverified", severity: "warn", label: "MCP não-verificado", detail: `servidor "${s.name}" fora do allowlist` });
    }
    const dangerous = s.tools.filter((t) => DANGEROUS_TOOL_RE.test(t));
    if (dangerous.length) {
      out.push({
        kind: "shadow-capability",
        severity: "warn",
        label: "capability sensível",
        detail: `"${s.name}": ${dangerous.slice(0, 5).join(", ")}${dangerous.length > 5 ? "…" : ""}`,
      });
    }
  }
  return out;
}

/** Verdict agregado (pior severidade encontrada) — como os health gates. */
export function riskVerdict(findings: RiskFinding[]): RiskSeverity {
  if (findings.some((f) => f.severity === "critical")) return "critical";
  if (findings.some((f) => f.severity === "warn")) return "warn";
  return "info";
}
