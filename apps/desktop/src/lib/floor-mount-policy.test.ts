import { strict as assert } from "node:assert";
import { decideMounted, touchMru } from "./floor-mount-policy";

let passed = 0;

// ativo_sempre_monta: evita que o andar ativo suma da tela por não estar na MRU.
{
  const result = decideMounted({
    all: [
      { id: "f1", projectId: "p1" },
      { id: "f2", projectId: "p1" },
    ],
    activeProjectId: "p1",
    activeFloorId: "f2",
    currentlyMounted: [],
    mru: ["f1"],
    keepWarm: 1,
  });
  assert.ok(result.mount.has("f2"));
  passed++;
}

// keep_warm_zero_deixa_so_o_ativo: manter andares antigos montados vazaria memória.
{
  const result = decideMounted({
    all: [
      { id: "f1", projectId: "p1" },
      { id: "f2", projectId: "p1" },
      { id: "f3", projectId: "p1" },
    ],
    activeProjectId: "p1",
    activeFloorId: "f2",
    currentlyMounted: ["f1", "f2", "f3"],
    mru: ["f1", "f3"],
    keepWarm: 0,
  });
  assert.deepStrictEqual(result.mount, new Set(["f2"]));
  assert.deepStrictEqual(result.unmount, ["f1", "f3"]);
  passed++;
}

// keep_warm_mantem_os_mais_recentes: sem aquecimento voltar para andares recentes remontaria tudo do zero.
{
  const result = decideMounted({
    all: [
      { id: "f1", projectId: "p1" },
      { id: "f2", projectId: "p1" },
      { id: "f3", projectId: "p1" },
      { id: "f4", projectId: "p1" },
      { id: "f5", projectId: "p1" },
    ],
    activeProjectId: "p1",
    activeFloorId: "f5",
    currentlyMounted: [],
    mru: ["f1", "f2", "f3", "f4"],
    keepWarm: 2,
  });
  assert.deepStrictEqual(result.mount, new Set(["f5", "f1", "f2"]));
  assert.deepStrictEqual(result.unmount, []);
  passed++;
}

// pinned_nao_desmonta: desmontar um sketch com alterações não salvas perderia trabalho do usuário.
{
  const result = decideMounted({
    all: [
      { id: "f1", projectId: "p1" },
      { id: "f2", projectId: "p1" },
      { id: "f3", projectId: "p1" },
    ],
    activeProjectId: "p1",
    activeFloorId: "f2",
    currentlyMounted: ["f1", "f2", "f3"],
    mru: ["f2"],
    keepWarm: 0,
    pinned: ["f3"],
  });
  assert.deepStrictEqual(result.mount, new Set(["f2", "f3"]));
  assert.deepStrictEqual(result.unmount, ["f1"]);
  passed++;
}

// floor_apagado_desmonta_mesmo_pinned: manter um floor deletado montado causaria referência a dados inexistentes.
{
  const result = decideMounted({
    all: [
      { id: "f1", projectId: "p1" },
      { id: "f2", projectId: "p1" },
    ],
    activeProjectId: "p1",
    activeFloorId: "f1",
    currentlyMounted: ["f1", "f2", "f3"],
    mru: [],
    keepWarm: 0,
    pinned: ["f3"],
  });
  assert.deepStrictEqual(result.mount, new Set(["f1"]));
  assert.deepStrictEqual(result.unmount, ["f2", "f3"]);
  passed++;
}

// sem_ativo_nada_e_forcado: forçar montagem sem ativo poluiria o DOM com andares desnecessários.
{
  const result = decideMounted({
    all: [
      { id: "f1", projectId: "p1" },
      { id: "f2", projectId: "p1" },
    ],
    activeProjectId: "p1",
    activeFloorId: null,
    currentlyMounted: ["f1"],
    mru: ["f1", "f2"],
    keepWarm: 2,
  });
  assert.deepStrictEqual(result.mount, new Set(["f1", "f2"]));
  assert.deepStrictEqual(result.unmount, []);
  passed++;
}

// unmount_preserva_a_ordem_de_currentlyMounted: ordem instável de desmontagem quebraria transições do Canvas.
{
  const result = decideMounted({
    all: [
      { id: "f1", projectId: "p1" },
      { id: "f2", projectId: "p1" },
      { id: "f3", projectId: "p1" },
      { id: "f4", projectId: "p1" },
    ],
    activeProjectId: "p1",
    activeFloorId: "f1",
    currentlyMounted: ["f4", "f2", "f3", "f1"],
    mru: [],
    keepWarm: 0,
  });
  assert.deepStrictEqual(result.mount, new Set(["f1"]));
  assert.deepStrictEqual(result.unmount, ["f4", "f2", "f3"]);
  passed++;
}

// mru_de_outro_projeto_conta_igual: ignorar MRU de outros projetos faria remontagem ao trocar de contexto.
{
  const result = decideMounted({
    all: [
      { id: "f1", projectId: "p1" },
      { id: "f2", projectId: "p2" },
    ],
    activeProjectId: "p1",
    activeFloorId: "f1",
    currentlyMounted: [],
    mru: ["f2", "f1"],
    keepWarm: 1,
  });
  assert.deepStrictEqual(result.mount, new Set(["f1", "f2"]));
  assert.deepStrictEqual(result.unmount, []);
  passed++;
}

// keepWarm_negativo_vira_zero: keepWarm negativo montaria infinitamente andares, estourando memória.
{
  const result = decideMounted({
    all: [
      { id: "f1", projectId: "p1" },
      { id: "f2", projectId: "p1" },
      { id: "f3", projectId: "p1" },
    ],
    activeProjectId: "p1",
    activeFloorId: "f1",
    currentlyMounted: [],
    mru: ["f2", "f3"],
    keepWarm: -5,
  });
  assert.deepStrictEqual(result.mount, new Set(["f1"]));
  assert.deepStrictEqual(result.unmount, []);
  passed++;
}

// touchMru_move_pro_topo_sem_duplicar: MRU duplicada ou sem limite corromperia a heurística de aquecimento.
{
  const reordenada = touchMru(["a", "b", "c", "d"], "c", 4);
  assert.deepStrictEqual(reordenada, ["c", "a", "b", "d"]);

  const comLimite = touchMru(["a", "b", "c", "d"], "c", 3);
  assert.deepStrictEqual(comLimite, ["c", "a", "b"]);

  const novoId = touchMru(["a", "b", "c"], "d", 3);
  assert.deepStrictEqual(novoId, ["d", "a", "b"]);
  passed++;
}

console.log(`${passed} testes passaram`);
