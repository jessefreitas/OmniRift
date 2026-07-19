// apps/desktop/src/lib/boot-armor.test.ts

/**
 * GUARDA DE REGRESSÃO: cena da armadura do boot
 *
 * A cena da armadura desenha num <canvas> que só tinha `position:fixed;inset:0`
 * no CSS, sem width/height explícitos. Canvas é um elemento *replaced*: quando
 * posicionado de forma absoluta com width:auto, o CSS resolve a largura pela
 * dimensão INTRÍNSECA (atributo cv.width = innerWidth * dpr) e descarta o
 * right:0 por over-constraint. Num display dpr=2 o canvas era exibido com o DOBRO
 * da largura da janela, ancorado à esquerda — tudo desenhado em W/2 aparecia na
 * borda direita. A matemática da cena estava correta; quem mentia era a
 * apresentação. O fix trava o tamanho de exibição dentro do resize() da própria
 * cena (cv.style.width/height em px), sem depender de CSS externo.
 */

import { runArmorScene } from "@/lib/boot-armor";

let falhas = 0;

function check(nome: string, cond: boolean, detalhe?: string) {
  if (cond) {
    console.log(`  ok  ${nome}`);
  } else {
    falhas++;
    console.error(`FAIL  ${nome} — ${detalhe ?? "falhou"}`);
  }
}

function instalarAmbienteBrowser(width: number, height: number, dpr: number) {
  (globalThis as any).window = globalThis;
  (globalThis as any).innerWidth = width;
  (globalThis as any).innerHeight = height;
  (globalThis as any).devicePixelRatio = dpr;
  (globalThis as any).addEventListener = () => {};
  (globalThis as any).removeEventListener = () => {};
  (globalThis as any).requestAnimationFrame = () => 0;
  (globalThis as any).cancelAnimationFrame = () => {};

  class Path2DStub {
    constructor(_path?: string | Path2D) {}
  }
  (globalThis as any).Path2D = Path2DStub;
}

function criarCanvasFalso(): HTMLCanvasElement {
  const ctxTarget: Record<string, any> = {};

  const ctx = new Proxy(ctxTarget, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return () => {};
    },
    set(target, prop, value) {
      target[prop as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;

  const style: Record<string, string> = {};

  const cv = {
    width: 0,
    height: 0,
    style,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;

  return cv;
}

type Cena = { stop(): void };

function cenarioA() {
  console.log("Cenário A — HiDPI 1920x1080 dpr=2");
  instalarAmbienteBrowser(1920, 1080, 2);
  const cv = criarCanvasFalso();
  const cena = runArmorScene(cv) as Cena;

  check(
    "buffer do canvas é escalado por dpr",
    cv.width === 3840 && cv.height === 2160,
    `width=${cv.width}, height=${cv.height}`
  );
  check(
    "tamanho de EXIBIÇÃO é travado na janela, não no buffer",
    cv.style.width === "1920px" && cv.style.height === "1080px",
    `style.width=${cv.style.width}, style.height=${cv.style.height}`
  );

  cena.stop();
}

function cenarioB() {
  console.log("Cenário B — 1280x800 dpr=1");
  instalarAmbienteBrowser(1280, 800, 1);
  const cv = criarCanvasFalso();
  const cena = runArmorScene(cv) as Cena;

  check(
    "buffer do canvas bate com a janela em dpr=1",
    cv.width === 1280 && cv.height === 800,
    `width=${cv.width}, height=${cv.height}`
  );
  check(
    "tamanho de exibição bate com a janela",
    cv.style.width === "1280px" && cv.style.height === "800px",
    `style.width=${cv.style.width}, style.height=${cv.style.height}`
  );

  cena.stop();
}

function cenarioC() {
  console.log("Cenário C — 1000x1000 dpr=4 (limitado a 2)");
  instalarAmbienteBrowser(1000, 1000, 4);
  const cv = criarCanvasFalso();
  const cena = runArmorScene(cv) as Cena;

  check(
    "dpr é limitado a 2 no buffer",
    cv.width === 2000 && cv.height === 2000,
    `width=${cv.width}, height=${cv.height}`
  );
  check(
    "tamanho de exibição respeita a janela apesar do dpr alto",
    cv.style.width === "1000px" && cv.style.height === "1000px",
    `style.width=${cv.style.width}, style.height=${cv.style.height}`
  );

  cena.stop();
}

cenarioA();
cenarioB();
cenarioC();

if (falhas > 0) {
  console.error(`\n${falhas} teste(s) falharam.`);
  process.exit(1);
} else {
  console.log("\nTodos os cenários passaram.");
}
