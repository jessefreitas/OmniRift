import { strict as assert } from "node:assert";
import { DragBuffer, type ChangeLike } from "./drag-buffer";

let passed = 0;

// Evita escrever posição no store enquanto o usuário ainda está arrastando.
{
  const buffer = new DragBuffer();
  const c1 = buffer.absorb([
    { id: "n1", type: "position", position: { x: 1, y: 1 }, dragging: true },
  ]);
  const c2 = buffer.absorb([
    { id: "n1", type: "position", position: { x: 2, y: 2 }, dragging: true },
    { id: "n1", type: "position", position: { x: 3, y: 3 }, dragging: true },
  ]);
  assert.equal(c1.positions.size, 0);
  assert.equal(c1.sizes.size, 0);
  assert.deepStrictEqual(c1.removed, []);
  assert.equal(c2.positions.size, 0);
  assert.equal(buffer.inFlight, true);
  assert.deepStrictEqual(buffer.pendingPos("n1"), { x: 3, y: 3 });
  passed++;
}

// Garante que só a posição final do gesto seja persistida no store.
{
  const buffer = new DragBuffer();
  buffer.absorb([
    { id: "n1", type: "position", position: { x: 0, y: 0 }, dragging: true },
  ]);
  buffer.absorb([
    { id: "n1", type: "position", position: { x: 5, y: 5 }, dragging: true },
  ]);
  const end = buffer.absorb([
    { id: "n1", type: "position", position: { x: 10, y: 10 }, dragging: false },
  ]);
  assert.deepStrictEqual(end.positions.get("n1"), { x: 10, y: 10 });
  assert.equal(end.positions.size, 1);
  assert.equal(buffer.inFlight, false);
  assert.equal(buffer.pendingPos("n1"), undefined);
  passed++;
}

// Impede que soltar o nó sem posição o faça voltar ao lugar anterior.
{
  const buffer = new DragBuffer();
  buffer.absorb([
    { id: "n1", type: "position", position: { x: 7, y: 8 }, dragging: true },
  ]);
  const end = buffer.absorb([{ id: "n1", type: "position", dragging: false }]);
  assert.deepStrictEqual(end.positions.get("n1"), { x: 7, y: 8 });
  assert.equal(buffer.inFlight, false);
  passed++;
}

// Medição inicial do ReactFlow precisa comitar imediatamente para o nó ter tamanho.
{
  const buffer = new DragBuffer();
  const commit = buffer.absorb([
    { id: "n1", type: "dimensions", dimensions: { width: 100, height: 50 } },
  ]);
  assert.deepStrictEqual(commit.sizes.get("n1"), { width: 100, height: 50 });
  assert.equal(commit.positions.size, 0);
  assert.equal(commit.removed.length, 0);
  assert.equal(buffer.inFlight, false);
  passed++;
}

// Durante o resize o tamanho fica em voo; só o tamanho final vai pro store.
{
  const buffer = new DragBuffer();
  const during = buffer.absorb([
    { id: "n1", type: "dimensions", dimensions: { width: 120, height: 60 }, resizing: true },
  ]);
  assert.equal(during.sizes.size, 0);
  assert.equal(buffer.inFlight, true);
  const end = buffer.absorb([
    { id: "n1", type: "dimensions", dimensions: { width: 130, height: 70 }, resizing: false },
  ]);
  assert.deepStrictEqual(end.sizes.get("n1"), { width: 130, height: 70 });
  assert.equal(buffer.inFlight, false);
  passed++;
}

// Remover um nó em arrasto não pode deixar posição órfã para id inexistente.
{
  const buffer = new DragBuffer();
  buffer.absorb([
    { id: "n1", type: "position", position: { x: 7, y: 8 }, dragging: true },
  ]);
  const commit = buffer.absorb([{ id: "n1", type: "remove" }]);
  assert.deepStrictEqual(commit.removed, ["n1"]);
  assert.equal(commit.positions.size, 0);
  assert.equal(commit.sizes.size, 0);
  assert.equal(buffer.inFlight, false);
  assert.equal(buffer.pendingPos("n1"), undefined);
  passed++;
}

// Um único lote de changes deve processar position em voo, dimensions e remove corretamente.
{
  const buffer = new DragBuffer();
  const commit = buffer.absorb([
    { id: "A", type: "position", position: { x: 1, y: 2 }, dragging: true },
    { id: "B", type: "dimensions", dimensions: { width: 50, height: 30 } },
    { id: "C", type: "remove" },
  ]);
  assert.equal(commit.positions.size, 0);
  assert.deepStrictEqual(commit.sizes.get("B"), { width: 50, height: 30 });
  assert.deepStrictEqual(commit.removed, ["C"]);
  assert.equal(buffer.inFlight, true);
  assert.deepStrictEqual(buffer.pendingPos("A"), { x: 1, y: 2 });
  passed++;
}

// Changes malformados não podem travar o canvas nem poluir o commit.
{
  const buffer = new DragBuffer();
  let threw = false;
  try {
    buffer.absorb([
      undefined as unknown as ChangeLike,
      { type: "position" } as unknown as ChangeLike,
      { id: "n1", type: "position" },
      { id: "n1", type: "unknown" } as ChangeLike,
    ]);
  } catch {
    threw = true;
  }
  assert.equal(threw, false);
  const commit = buffer.absorb([]);
  assert.equal(commit.positions.size, 0);
  assert.equal(commit.sizes.size, 0);
  assert.deepStrictEqual(commit.removed, []);
  passed++;
}

// Ao trocar de floor/desmontar, todo estado pendente deve ser descartado.
{
  const buffer = new DragBuffer();
  buffer.absorb([
    { id: "n1", type: "position", position: { x: 1, y: 1 }, dragging: true },
  ]);
  buffer.absorb([
    { id: "n2", type: "dimensions", dimensions: { width: 10, height: 10 }, resizing: true },
  ]);
  buffer.clear();
  assert.equal(buffer.inFlight, false);
  assert.equal(buffer.pendingPos("n1"), undefined);
  assert.equal(buffer.pendingSize("n2"), undefined);
  passed++;
}

console.log(`${passed} testes passaram em drag-buffer.test.ts`);
