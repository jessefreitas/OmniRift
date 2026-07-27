// acp-hygiene.ts — higiene T2 (omp): caps razoáveis ao hidratar updates ACP no front.
// Espelha soft-caps do EventLog backend (UPDATE_TEXT_SOFT_CAP = 4096) + janela de bolhas.

/** Soft-cap de chars por chunk de texto ao aplicar update (agent_message_chunk). */
export const ACP_UPDATE_CHUNK_SOFT_CAP = 4096;
/** Quando o histórico de bolhas passa deste tamanho, corta. */
export const ACP_MSG_HISTORY_SOFT = 600;
/** Quantas bolhas manter após o corte. */
export const ACP_MSG_HISTORY_KEEP = 400;

/** Trunca texto por chars (não bytes) — nunca parte no meio de um code point. */
export function capAcpText(
  text: string,
  max: number = ACP_UPDATE_CHUNK_SOFT_CAP,
): string {
  if (max <= 0) return "";
  if ([...text].length <= max) return text;
  return [...text].slice(0, max).join("");
}

/** Mantém janela de histórico de bolhas (sessões longas → peso de render). */
export function trimAcpMsgHistory<T>(
  msgs: T[],
  soft: number = ACP_MSG_HISTORY_SOFT,
  keep: number = ACP_MSG_HISTORY_KEEP,
): T[] {
  if (msgs.length <= soft) return msgs;
  return msgs.slice(-keep);
}
