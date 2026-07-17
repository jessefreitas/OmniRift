// Espera `done` OU o teto `capMs` (o que vier primeiro) e NUNCA rejeita. O fechamento da intro
// aguarda a saudação terminar, mas o teto garante que uma falha de áudio nunca prenda o usuário.
export function gateClose(done: Promise<unknown>, capMs: number): Promise<void> {
  return Promise.race([
    Promise.resolve(done).then(() => {}, () => {}),
    new Promise<void>((r) => setTimeout(r, capMs)),
  ]);
}
