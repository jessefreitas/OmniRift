// src/lib/action-trail.ts
//
// Registra ações do usuário no arquivo de debug para diagnóstico de suporte.
// Enquanto o log técnico mostra o que o backend executou, esta trilha mostra
// O QUE o cliente clicou/acionou antes de um erro. Por sair da máquina do cliente,
// privacidade é prioridade: o chamador NUNCA deve passar prompts, código ou texto
// de campos; o módulo ainda trunca valores e remove caminhos para reduzir exposição
// acidental.

import { logToDisk } from "@/lib/debug-log";

// ── Escopo e persistência ─────────────────────────────────────────
const STORAGE_KEY = "omnirift-trail-scope";

export type TrailScope = "off" | "technical" | "actions";

/**
 * Lê o escopo sempre do localStorage. O teste precisa poder trocar o storage
 * a qualquer momento, então não cacheamos em variável de módulo.
 */
export function getTrailScope(): TrailScope {
  try {
    if (typeof localStorage === "undefined") return "off";
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "off" || raw === "technical" || raw === "actions") return raw;
  } catch {
    // Ambientes sem localStorage ou com quota bloqueada devem degradar para off.
  }
  return "off";
}

/**
 * Persiste o escopo sem propagar erros; preferimos ficar sem trilha a quebrar
 * o chamador em ambientes restritos.
 */
export function setTrailScope(s: TrailScope): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, s);
    }
  } catch {
    // Ignora silenciosamente para nunca lançar.
  }
}

// ── Privacidade e sanitização ─────────────────────────────────────
const MAX_VALUE_CHARS = 120;
const MAX_JSON_CHARS = 300;
const MAX_ACTION_CHARS = 60;
const MAX_KEY_CHARS = 40;

/**
 * Converte qualquer valor para string curta e legível. Strings vão truncadas;
 * números, booleanos e null usam String(); objetos/arrays usam JSON.stringify
 * com proteção contra referência circular. Isso evita que um campo inesperado
 * estoure a linha de log ou exponha estruturas enormes.
 */
function sanitizeValue(value: unknown): string {
  let text: string;

  if (typeof value === "string") {
    // Caminhos completos revelam identidade do cliente/projeto; mantemos só o nome.
    text = hasPathSeparator(value) ? basename(value) : value;
  } else if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    text = String(value);
  } else {
    text = safeStringify(value);
  }

  return truncate(flatten(text), MAX_VALUE_CHARS);
}

function hasPathSeparator(text: string): boolean {
  return text.includes("/") || text.includes("\\");
}

/**
 * Retorna o último segmento não vazio do caminho, respeitando ambos os separadores.
 * Caminhos terminados em separador caem no segmento anterior (último não vazio).
 */
function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part !== "") return part;
  }
  return "";
}

function safeStringify(value: unknown): string {
  try {
    // O basename do `sanitizeValue` só alcança string DIRETA. Sem este replacer, um
    // caminho aninhado (`{ meta: { path: "/home/fulano/clientes/acme/main.rs" } }`)
    // era serializado cru e vazava a pasta do cliente inteira num arquivo que SAI da
    // máquina dele. O replacer aplica a mesma regra em qualquer profundidade.
    const json = JSON.stringify(value, (_k, v) =>
      typeof v === "string" && hasPathSeparator(v) ? basename(v) : v,
    );
    // JSON.stringify devolve `undefined` (não string!) para undefined/função/símbolo.
    // Sem esta guarda o truncate estoura e a ação some silenciosamente no catch do
    // trackAction — o pior tipo de falha num módulo de diagnóstico.
    return typeof json === "string" ? json : String(value);
  } catch {
    // JSON.stringify pode falhar em estruturas circulares ou com BigInt.
    return "[obj]";
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

/**
 * Achata quebras de linha e caracteres de controle. Uma linha de log é uma linha:
 * sem isso, um valor com "\n[ERRO] ..." forja entradas falsas no arquivo que o
 * suporte vai ler como se fossem do app (log injection).
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

function flatten(text: string): string {
  return text.replace(CONTROL_CHARS, " ");
}

function sanitizeDetail(detail: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(detail)) {
    // A CHAVE também vaza: `{ "token_do_cliente_acme": 1 }` conta a história inteira
    // sem nunca olhar o valor.
    out[truncate(flatten(key), MAX_KEY_CHARS)] = sanitizeValue(detail[key]);
  }
  return out;
}

function serializeDetail(detail: Record<string, unknown>): string {
  const sanitized = sanitizeDetail(detail);
  const json = JSON.stringify(sanitized);
  // Truncamos o JSON total como string legível, não precisa continuar válido.
  return truncate(json, MAX_JSON_CHARS);
}

function buildLine(action: string, detail?: Record<string, unknown>): string {
  const iso = new Date().toISOString();
  // O nome da ação também passa pelo filtro: é o chamador que o escolhe, mas um nome
  // montado com dado do usuário (ex: `abrir-${nomeDoArquivo}`) vazaria do mesmo jeito.
  const prefix = `[${iso}] [👤 AÇÃO] ${truncate(flatten(action), MAX_ACTION_CHARS)}`;

  if (!detail || Object.keys(detail).length === 0) {
    // Sem detalhe evitamos espaço solitário no final da linha.
    return prefix;
  }

  return `${prefix} ${serializeDetail(detail)}`;
}

// ── Limitação de taxa ─────────────────────────────────────────────
const RATE_WINDOW_MS = 1000;
const RATE_LIMIT = 20;

// Estado volátil; clearTrail() reseta tudo para permitir "esquecer" o passado.
let windowStart = 0;
let writtenInWindow = 0;
let suppressed = 0;

/**
 * Escreve no disco. SEM buffer em memória de propósito: o pacote de diagnóstico
 * lê o debug.log do DISCO, então um ring aqui seria uma segunda cópia que ninguém
 * consome — e o disco é justamente o que sobrevive ao WebView travado (ver debug-log.ts).
 * Isolamos o logToDisk pra falha de gravação não vazar pro chamador.
 */
function writeLine(line: string): void {
  try {
    logToDisk(line);
  } catch {
    // Nunca propagamos falha de gravação; a ação do usuário não pode quebrar.
  }
}

function emitSuppressed(count: number, now: number): void {
  const iso = new Date(now).toISOString();
  writeLine(`[${iso}] [👤 AÇÃO] …${count} ações suprimidas`);
  writtenInWindow++;
}

// ── API pública ───────────────────────────────────────────────────
/**
 * Registra uma ação do usuário quando o escopo for "actions". Aplica janela FIXA
 * de taxa: estourado o teto, acumula suprimidas e só reporta quando
 * a janela vira, evitando spam no arquivo do cliente.
 */
export function trackAction(action: string, detail?: Record<string, unknown>): void {
  try {
    if (getTrailScope() !== "actions") return;

    const line = buildLine(action, detail);
    const now = Date.now();

    // Virada de janela: reporta suprimidas antes de registrar a ação atual.
    if (now - windowStart > RATE_WINDOW_MS) {
      const previousSuppressed = suppressed;
      windowStart = now;
      writtenInWindow = 0;
      suppressed = 0;

      if (previousSuppressed > 0) {
        emitSuppressed(previousSuppressed, now);
      }
    }

    if (writtenInWindow < RATE_LIMIT) {
      writeLine(line);
      writtenInWindow++;
    } else {
      // Dentro da janela cheia só contamos; não geramos linha para não amplificar.
      suppressed++;
    }
  } catch {
    // A trilha é observabilidade secundária: nunca deve interromper a app.
  }
}

/**
 * Zera o estado do limitador de taxa. O escopo permanece inalterado para não
 * perder a preferência do usuário.
 */
export function clearTrail(): void {
  windowStart = 0;
  writtenInWindow = 0;
  suppressed = 0;
}