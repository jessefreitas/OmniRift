// apps/desktop/src/lib/drag-buffer.ts
//
// PORQUÊ este módulo existe:
// A auditoria mediu que `FloorCanvas.onNodesChange` escrevia posição e tamanho
// diretamente no Zustand a CADA evento do ReactFlow durante arrastar/redimensionar.
// Cada escrita fazia o store procurar o floor, remapear arrays e notificar todos os
// assinantes — dezenas de vezes por segundo, re-renderizando o canvas inteiro.
//
// A correção é acumular as mudanças localmente durante o gesto e gravar UMA vez
// no fim. Esta classe é a lógica PURA dessa bufferização: sem React, sem zustand,
// sem import do ReactFlow, para poder ser testada no Node.
//

export interface Pos {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Só o que o buffer precisa saber de um evento do ReactFlow. */
export interface ChangeLike {
  id: string;
  type: "position" | "dimensions" | "remove" | string;
  position?: Pos;
  dimensions?: Size;
  /** true enquanto o gesto está em curso; false/undefined quando terminou. */
  dragging?: boolean;
  resizing?: boolean;
}

export interface Commit {
  positions: Map<string, Pos>;
  sizes: Map<string, Size>;
  removed: string[];
}

export class DragBuffer {
  // Valores "em voo": modificados durante um gesto ativo, ainda NÃO commitados.
  private _positions = new Map<string, Pos>();
  private _sizes = new Map<string, Size>();

  /**
   * Absorve um lote de changes e devolve o que deve ir pro store AGORA.
   * Durante um gesto (dragging/resizing === true) os valores ficam no buffer;
   * só saem no commit quando o gesto termina ou quando são atualizações
   * imediatas (medição inicial, fim de redimensionamento, remoção).
   */
  absorb(changes: ChangeLike[]): Commit {
    const toCommitPos = new Map<string, Pos>();
    const toCommitSize = new Map<string, Size>();
    const removedNow = new Set<string>();

    for (const change of changes) {
      // Mudanças malformadas são ignoradas: absorb NUNCA lança.
      if (!change || typeof change.id !== "string" || change.id === "") {
        continue;
      }

      const { id, type } = change;

      // Se o nó já foi removido neste mesmo lote, ignorar atualizações posteriores.
      if (removedNow.has(id)) {
        continue;
      }

      if (type === "position") {
        if (change.dragging === true) {
          // Gesto em curso: guarda por cima do store, NÃO commita ainda.
          if (change.position) {
            this._positions.set(id, { ...change.position });
          }
        } else {
          // Fim do arrasto (ou update não-arrasto): commita a posição final.
          // Prioriza o valor do evento; se ele não veio, usa o último em voo.
          const final = change.position ?? this._positions.get(id);
          this._positions.delete(id);
          if (final) {
            toCommitPos.set(id, { ...final });
          }
        }
      } else if (type === "dimensions") {
        if (change.resizing === true) {
          // Redimensionamento em curso: acumula localmente.
          if (change.dimensions) {
            this._sizes.set(id, { ...change.dimensions });
          }
        } else {
          // Medição inicial ou fim de resize: commita o tamanho imediatamente.
          const final = change.dimensions ?? this._sizes.get(id);
          this._sizes.delete(id);
          if (final) {
            toCommitSize.set(id, { ...final });
          }
        }
      } else if (type === "remove") {
        // Remove o nó do store e limpa qualquer estado em voo, para não deixar
        // posição/tamanho órfãos que seriam aplicados a um id que não existe mais.
        this._positions.delete(id);
        this._sizes.delete(id);
        toCommitPos.delete(id);
        toCommitSize.delete(id);
        removedNow.add(id);
      }
    }

    return {
      positions: toCommitPos,
      sizes: toCommitSize,
      removed: Array.from(removedNow),
    };
  }

  /** Posição em voo de um nó (o render usa por cima do store), ou undefined. */
  pendingPos(id: string): Pos | undefined {
    const p = this._positions.get(id);
    return p ? { ...p } : undefined;
  }

  /** Tamanho em voo de um nó (o render usa por cima do store), ou undefined. */
  pendingSize(id: string): Size | undefined {
    const s = this._sizes.get(id);
    return s ? { ...s } : undefined;
  }

  /** Há algum gesto em curso? O render usa isso para decidir se mescla valores. */
  get inFlight(): boolean {
    return this._positions.size > 0 || this._sizes.size > 0;
  }

  /** Descarta todo o estado acumulado (desmonte do componente / troca de floor). */
  clear(): void {
    this._positions.clear();
    this._sizes.clear();
  }
}
