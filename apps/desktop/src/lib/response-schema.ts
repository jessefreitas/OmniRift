// src/lib/response-schema.ts
//
// Validação TIPADA das conexões (Fase 2 — conexões semânticas, roubada do LangChain
// task()/responseSchema). Quando uma edge A→B tem um `responseSchema`, a saída do turno
// de A é validada contra ele. Sem lib externa (o projeto não tem ajv/zod e não vamos
// adicionar peso): um validador estrutural MÍNIMO de JSON Schema (type + required +
// properties + items + enum), recursivo pela FORMA DO SCHEMA (não pelos dados → sempre
// termina). O schema pode ser:
//   • um JSON Schema de verdade ({ type, properties, required, ... })
//   • um EXEMPLO JSON (objeto/array/valor) → inferimos a forma dele (tipo + chaves)
//   • texto livre/descrição → não dá pra validar estruturalmente ⇒ retorna null (no-op)
//
// Degrada limpo: qualquer coisa que não seja JSON parseável no schema = null (conexão
// segue funcionando exatamente como antes, sem badge, sem bloqueio).

import type { EdgeValidation } from "@/types/canvas";

export type { EdgeValidation };

type JsonSchema = Record<string, unknown>;

const SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const SCHEMA_KEYWORDS = new Set([
  "type", "properties", "required", "items", "$schema", "$id", "title", "description",
  "additionalProperties", "enum", "const", "format", "minimum", "maximum",
  "minLength", "maxLength", "minItems", "maxItems", "pattern", "default", "examples",
]);

/** Tipo JSON de um valor (para casar com o `type` do schema). */
function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // "object" | "string" | "number" | "boolean" | "undefined" | ...
}

/** Parse tolerante: retorna `{ found, value }` (distingue "não é JSON" de um `null`/`false`
 *  legítimos, que JSON.parse aceita e não podem virar sentinela). */
function tryParse(text: string): { found: true; value: unknown } | { found: false } {
  try {
    return { found: true, value: JSON.parse(text) as unknown };
  } catch {
    return { found: false };
  }
}

/** Último objeto/array BALANCEADO no texto (string-aware p/ ignorar chaves dentro de aspas).
 *  Usado como último recurso quando o agente termina a resposta com um bloco JSON solto. */
function lastBalanced(text: string): string | null {
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const end = text.lastIndexOf(close);
    if (end === -1) continue;
    let depth = 0;
    let inStr = false;
    for (let i = end; i >= 0; i--) {
      const ch = text[i];
      if (ch === '"' && text[i - 1] !== "\\") {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (ch === close) depth++;
      else if (ch === open) {
        depth--;
        if (depth === 0) return text.slice(i, end + 1);
      }
    }
  }
  return null;
}

/** Extrai o JSON de uma saída de agente: (1) o texto inteiro; (2) o ÚLTIMO bloco cercado
 *  ```json ... ```; (3) o último objeto/array balanceado. Prosa em volta é ignorada. */
export function extractJson(text: string): { found: true; value: unknown } | { found: false } {
  const trimmed = text.trim();
  if (!trimmed) return { found: false };

  const whole = tryParse(trimmed);
  if (whole.found) return whole;

  const fences = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const p = tryParse(fences[i][1].trim());
    if (p.found) return p;
  }

  const cand = lastBalanced(trimmed);
  if (cand) {
    const p = tryParse(cand);
    if (p.found) return p;
  }
  return { found: false };
}

/** O objeto parseado do schema PARECE um JSON Schema (vs. um exemplo de dados que por acaso
 *  tem uma chave "type")? Heurística conservadora pra não confundir `{type:"sedan"}` (exemplo)
 *  com um schema. */
function looksLikeJsonSchema(obj: JsonSchema): boolean {
  if ("$schema" in obj || "properties" in obj || "items" in obj) return true;
  if (Array.isArray(obj.required)) return true;
  // { "type": "<tipo-de-schema>" } contendo SÓ palavras-chave de schema → é um schema.
  if (typeof obj.type === "string" && SCHEMA_TYPES.has(obj.type) &&
      Object.keys(obj).every((k) => SCHEMA_KEYWORDS.has(k))) return true;
  return false;
}

/** Infere um schema raso a partir de um EXEMPLO: tipo do valor e, se for objeto, as chaves
 *  presentes viram `required` com o tipo de cada uma (validação top-level + 1 nível). */
function inferSchemaFromExample(example: unknown): JsonSchema {
  const t = jsonType(example);
  if (t === "object") {
    const obj = example as Record<string, unknown>;
    const properties: Record<string, JsonSchema> = {};
    for (const [k, v] of Object.entries(obj)) properties[k] = { type: jsonType(v) };
    return { type: "object", properties, required: Object.keys(obj) };
  }
  if (t === "array") {
    const arr = example as unknown[];
    return arr.length ? { type: "array", items: { type: jsonType(arr[0]) } } : { type: "array" };
  }
  return { type: t };
}

/** Converte o texto do schema em um schema utilizável, ou null se for prosa (não-JSON). */
function coerceSchema(text: string): JsonSchema | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parsed = tryParse(trimmed);
  if (!parsed.found) return null; // texto livre — nada a validar estruturalmente
  const val = parsed.value;
  if (val && typeof val === "object" && !Array.isArray(val)) {
    const obj = val as JsonSchema;
    return looksLikeJsonSchema(obj) ? obj : inferSchemaFromExample(obj);
  }
  // exemplo array ou primitivo
  return inferSchemaFromExample(val);
}

/** Valida `value` contra `schema`, recursivo pela forma do schema. Retorna a 1ª mensagem de
 *  erro (pt-BR) ou null se passar. `path` é o caminho legível pro erro ($, $.x, $[0]). */
function checkAgainst(value: unknown, schema: JsonSchema, path: string): string | null {
  const wanted = typeof schema.type === "string" ? schema.type : undefined;
  const actual = jsonType(value);

  if (wanted) {
    if (wanted === "integer") {
      if (actual !== "number" || !Number.isInteger(value)) {
        return `${path}: esperado integer, veio ${actual}`;
      }
    } else if (wanted === "number") {
      if (actual !== "number") return `${path}: esperado number, veio ${actual}`;
    } else if (wanted !== actual) {
      return `${path}: esperado ${wanted}, veio ${actual}`;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === value)) {
    return `${path}: valor "${String(value)}" fora do enum permitido`;
  }

  // objeto: required + properties (1º erro encontrado)
  const isObjectShape = wanted === "object" || "properties" in schema || "required" in schema;
  if (isObjectShape && actual === "object") {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !(key in obj)) {
          return `${path}: falta a chave obrigatória "${key}"`;
        }
      }
    }
    if (schema.properties && typeof schema.properties === "object") {
      for (const [key, sub] of Object.entries(schema.properties as Record<string, unknown>)) {
        if (key in obj && sub && typeof sub === "object") {
          const err = checkAgainst(obj[key], sub as JsonSchema, `${path}.${key}`);
          if (err) return err;
        }
      }
    }
  }

  // array: items
  if ((wanted === "array" || "items" in schema) && actual === "array" &&
      schema.items && typeof schema.items === "object") {
    const arr = value as unknown[];
    for (let i = 0; i < arr.length; i++) {
      const err = checkAgainst(arr[i], schema.items as JsonSchema, `${path}[${i}]`);
      if (err) return err;
    }
  }

  return null;
}

/**
 * Valida a saída de um agente contra o `responseSchema` (texto) de uma conexão.
 * Retorna:
 *   • `EdgeValidation` {ok,at,error?} quando deu pra validar (schema JSON ou exemplo JSON)
 *   • `null` quando o schema é texto livre/descrição (nada a validar estruturalmente na v1)
 */
export function validateOutputAgainstSchema(
  out: { text: string; diff?: string },
  schemaText: string,
): EdgeValidation | null {
  const schema = coerceSchema(schemaText);
  if (!schema) return null;

  const at = Date.now();
  const extracted = extractJson(out.text ?? "");
  if (!extracted.found) {
    return { ok: false, at, error: "a saída não contém JSON parseável" };
  }
  const err = checkAgainst(extracted.value, schema, "$");
  return err ? { ok: false, at, error: err } : { ok: true, at };
}
