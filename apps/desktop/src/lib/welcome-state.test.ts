import { strict as assert } from "node:assert";

import { EXPERIENCE_MODE_STORAGE_KEY } from "./experience-mode-core";
import { shouldShowWelcome, WELCOME_SEEN_KEY } from "./welcome-state";

function makeStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    get length() {
      return data.size;
    },
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
  };
}

// Instalação nova nasce em "light" e ganha o tour.
assert.strictEqual(
  shouldShowWelcome(makeStorage({ [EXPERIENCE_MODE_STORAGE_KEY]: "light" })),
  true,
);

assert.strictEqual(
  shouldShowWelcome(makeStorage({ [EXPERIENCE_MODE_STORAGE_KEY]: "pocket" })),
  true,
);

// Trava o pior caso: quem já usava o app levar tela de tutorial ao só atualizar.
assert.strictEqual(
  shouldShowWelcome(makeStorage({ [EXPERIENCE_MODE_STORAGE_KEY]: "full" })),
  false,
);

assert.strictEqual(
  shouldShowWelcome(
    makeStorage({
      [EXPERIENCE_MODE_STORAGE_KEY]: "light",
      [WELCOME_SEEN_KEY]: "1",
    }),
  ),
  false,
);

assert.strictEqual(shouldShowWelcome(makeStorage()), false);

const hostileStorage = {
  get length() {
    return 0;
  },
  getItem() {
    throw new Error("storage bloqueado");
  },
  setItem() {
    throw new Error("storage bloqueado");
  },
};

// Storage bloqueado no WebView não pode derrubar o boot nem repetir o tour a cada abertura.
assert.strictEqual(shouldShowWelcome(hostileStorage), false);

console.log("welcome-state: 6 testes passaram");