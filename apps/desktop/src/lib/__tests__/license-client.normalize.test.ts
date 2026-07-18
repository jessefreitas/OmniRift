import { describe, it, expect } from "vitest";
import { normalizePastedKey } from "@/lib/license-client";

describe("normalizePastedKey", () => {
  it("tira o número da lista numerada", () => {
    expect(normalizePastedKey("04 lic_o6FhbM4PwpuFO4pE")).toBe("lic_o6FhbM4PwpuFO4pE");
  });
  it("aceita a chave limpa", () => {
    expect(normalizePastedKey("lic_wN_SuIlaAWpSjRBG")).toBe("lic_wN_SuIlaAWpSjRBG");
  });
  it("tira espaço e quebra de linha do copiar/colar", () => {
    expect(normalizePastedKey("  lic_wN_SuIlaAWpSjRBG \n")).toBe("lic_wN_SuIlaAWpSjRBG");
  });
  it("extrai de frase de e-mail", () => {
    expect(normalizePastedKey("Sua licença: lic_Fst7nBL9oZdany4l — válida 60d")).toBe("lic_Fst7nBL9oZdany4l");
  });
  it("preserva entitlement payload.sig colado direto", () => {
    const ent = "eyJmcCI6ImZmZmZmZmZmZGVhZGJlZWYiLCJob2xkZXIiOiJ4In0.97yRNAC0mpkSEEyuzs9MOoJZpPUc0oEhTT71g58fjoA";
    expect(normalizePastedKey(`  ${ent}  `)).toBe(ent);
  });
  it("lixo sem chave volta como trim (servidor decide)", () => {
    expect(normalizePastedKey("  nada aqui  ")).toBe("nada aqui");
  });
});
