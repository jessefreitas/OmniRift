export interface FloorRef {
  id: string;
  projectId: string;
}

export interface MountDecision {
  /** Ids que devem estar montados agora. */
  mount: Set<string>;
  /** Ids que estavam montados e devem ser desmontados AGORA (pra o caller fazer flush antes). */
  unmount: string[];
}

export function decideMounted(args: {
  all: FloorRef[];
  activeProjectId: string | null;
  activeFloorId: string | null;
  currentlyMounted: Iterable<string>;
  mru: string[];
  keepWarm: number;
  pinned?: Iterable<string>;
}): MountDecision {
  const allIds = new Set(args.all.map((floor) => floor.id));
  const mount = new Set<string>();

  // O ativo é a única garantia absoluta: se ele existir, precisa estar no DOM.
  if (args.activeFloorId && allIds.has(args.activeFloorId)) {
    mount.add(args.activeFloorId);
  }

  // Andares recentemente visitados são mantidos "aquecidos" para evitar remontagem
  // custosa do ReactFlow/xterm quando o usuário volta (caso de uso mais comum).
  const warmLimit = Math.max(0, args.keepWarm);
  let warmed = 0;
  for (const id of args.mru) {
    if (warmed >= warmLimit) break;
    if (!allIds.has(id)) continue; // floor deletado não pode ser aquecido
    if (mount.has(id)) continue;   // já conta como montado, não gasta slot
    mount.add(id);
    warmed++;
  }

  // Pinned sobrevive a tudo, exceto à inexistência do floor (não dá manter o que sumiu).
  for (const id of args.pinned ?? []) {
    if (allIds.has(id)) {
      mount.add(id);
    }
  }

  // Ordem estável de desmontagem: respeita a ordem em que o caller conhece os montados,
  // facilitando transições determinísticas no Canvas.
  const currentlyMounted = [...args.currentlyMounted];
  const unmount = currentlyMounted.filter((id) => !mount.has(id));

  return { mount, unmount };
}

/** Move `id` pro topo da MRU, sem duplicar. Devolve nova lista (não muta). */
export function touchMru(mru: string[], id: string, limite: number = 10): string[] {
  // Reconstroi sem a ocorrência antiga para manter unicidade.
  const semId = mru.filter((x) => x !== id);
  // Mais recente sempre no topo: o caller usa essa ordem para decidir quem aquecer.
  const nova = [id, ...semId];
  return limite >= 0 ? nova.slice(0, limite) : nova;
}
