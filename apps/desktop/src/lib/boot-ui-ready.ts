// Gate: UI de boot (intro) liberou o canvas. Sidebar/scans pesados esperam isto
// pra não competir com persistência no cold start.

let ready = false;
const waiters: Array<() => void> = [];

/** Chamado quando o boot-intro fecha (ou se a flag boot-intro está off). */
export function markBootUiReady(): void {
  if (ready) return;
  ready = true;
  for (const w of waiters.splice(0)) w();
}

/** Resolve quando a UI principal está livre pro trabalho adiado. */
export function whenBootUiReady(): Promise<void> {
  if (ready) return Promise.resolve();
  return new Promise((resolve) => {
    waiters.push(resolve);
  });
}
