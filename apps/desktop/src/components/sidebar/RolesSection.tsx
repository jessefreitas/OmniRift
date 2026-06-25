import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Crown, UserCog, Plus, Pencil, Settings, ScanSearch, X, FileUp, Download } from "lucide-react";
import { nanoid } from "nanoid";

import { Tooltip } from "@/components/Tooltip";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";
import { notify } from "@/lib/notify";
import { ROLE_CLIS, type AgentRoleDef, type ImportedRole } from "@/lib/agent-roles";

interface RolesSectionProps {
  roles: AgentRoleDef[];
  currentCwd: string | null;
  isOpen: (key: string) => boolean;
  sectionTitle: (key: string, label: string) => ReactNode;
  discoverProjectRoles: () => Promise<void>;
  setEditingRole: (r: AgentRoleDef | null) => void;
  setLaunchPickerRole: (r: AgentRoleDef | null) => void;
  spawnRole: (r: AgentRoleDef, skillIdsOverride?: string[]) => Promise<void>;
  deleteRole: (id: string) => void;
  /** Adiciona um role já montado à biblioteca (persiste via Sidebar). */
  addRole: (r: AgentRoleDef) => void;
  secStyle: (id: string) => { order: number };
}

/** Slug seguro pra id de role (a-z0-9 + hífen, sem duplicados). */
function slugId(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s ? `${s}-${nanoid(4)}` : nanoid();
}

/** Seção ROLES — biblioteca de personas + import de arquivo + template baixável. */
export function RolesSection({
  roles,
  currentCwd,
  isOpen,
  sectionTitle,
  discoverProjectRoles,
  setEditingRole,
  setLaunchPickerRole,
  spawnRole,
  deleteRole,
  addRole,
  secStyle,
}: RolesSectionProps) {
  const tr = useT();
  // Preview do role importado (mini-dialog antes de criar). null = fechado.
  const [preview, setPreview] = useState<ImportedRole | null>(null);
  const [previewCli, setPreviewCli] = useState("claude");

  // ── Importar agente de arquivo (.toml Codex / .md Claude) ──
  async function importFromFile() {
    let path: string | string[] | null;
    try {
      path = await openDialog({
        title: tr("roles.importTitle", "Importar agente (arquivo)"),
        multiple: false,
        filters: [
          { name: tr("roles.importFilter", "Agente (.toml/.md)"), extensions: ["toml", "md"] },
        ],
      });
    } catch (e) {
      void notify(tr("roles.importFailed", "Falha ao importar:") + "\n" + String(e), "error");
      return;
    }
    if (!path || typeof path !== "string") return;
    try {
      const imported = await invoke<ImportedRole>("role_import_file", { path });
      setPreview(imported);
      setPreviewCli(imported.cli || "claude");
    } catch (e) {
      void notify(tr("roles.importFailed", "Falha ao importar:") + "\n" + String(e), "error");
    }
  }

  // Confirma a criação do role a partir do preview.
  function createFromPreview() {
    if (!preview) return;
    const novo: AgentRoleDef = {
      id: slugId(preview.name),
      name: preview.name,
      prompt: preview.prompt,
      cli: previewCli,
      sourcePath: preview.sourcePath || undefined,
      format: preview.format || undefined,
    };
    addRole(novo);
    setPreview(null);
    void notify(tr("roles.imported", "Role importado: {n}").replace("{n}", preview.name));
  }

  // ── Baixar modelo (template em branco reimportável) ──
  async function downloadTemplate(kind: "codex" | "claude") {
    let path: string | null;
    try {
      path = await saveDialog({
        title: tr("roles.templateTitle", "Baixar modelo de agente"),
        defaultPath: kind === "codex" ? "meu-agente.toml" : "meu-agente.md",
        filters: [
          { name: kind === "codex" ? "Codex (.toml)" : "Claude (.md)", extensions: [kind === "codex" ? "toml" : "md"] },
        ],
      });
    } catch (e) {
      void notify(tr("roles.templateFailed", "Falha ao baixar modelo:") + "\n" + String(e), "error");
      return;
    }
    if (!path) return;
    try {
      await invoke("role_template_save", { path, kind });
      void notify(tr("roles.templateSaved", "Modelo salvo: {p}").replace("{p}", path));
    } catch (e) {
      void notify(tr("roles.templateFailed", "Falha ao baixar modelo:") + "\n" + String(e), "error");
    }
  }

  return (
    <div className="px-2 py-2.5 border-t border-border" style={secStyle("roles")}>
      <div className="flex items-center justify-between px-2 mb-1.5">
        {sectionTitle("roles", tr("section.roles"))}
        <div className="flex items-center gap-0.5">
          <Tooltip label={tr("roles.importFromFile", "Importar agente de arquivo (.toml Codex / .md Claude)")} side="bottom">
            <button
              onClick={() => void importFromFile()}
              className="text-textMuted hover:text-brand p-0.5 rounded hover:bg-surface2 transition-colors"
            >
              <FileUp size={12} />
            </button>
          </Tooltip>
          <DownloadTemplateButton onPick={(k) => void downloadTemplate(k)} tr={tr} />
          {currentCwd && (
            <Tooltip label={tr("sidebar.discoverProjectRoles", "Descobrir roles do projeto (.claude/agents)")} side="bottom">
              <button
                onClick={() => void discoverProjectRoles()}
                className="text-textMuted hover:text-brand p-0.5 rounded hover:bg-surface2 transition-colors"
              >
                <ScanSearch size={12} />
              </button>
            </Tooltip>
          )}
          <Tooltip label={tr("sidebar.newCustomRole", "Novo role custom")} side="bottom">
            <button
              onClick={() => setEditingRole({ id: nanoid(), name: "", prompt: "" })}
              className="text-textMuted hover:text-brand p-0.5 rounded hover:bg-surface2 transition-colors"
            >
              <Plus size={12} />
            </button>
          </Tooltip>
        </div>
      </div>
      {isOpen("roles") && (
        <div className="space-y-1">
          {roles.map((r) => (
            <div
              key={r.id}
              className={cn(
                "group flex items-center gap-1.5 px-2 py-1 rounded hover:bg-surface2",
                r.master && "bg-yellow-400/5 ring-1 ring-yellow-400/20",
              )}
            >
              {r.master ? (
                <Crown size={12} className="text-yellow-400 shrink-0" />
              ) : (
                <UserCog size={12} className="text-brand/70 shrink-0" />
              )}
              <button
                onClick={() => void spawnRole(r)}
                title={r.prompt}
                className={cn(
                  "flex-1 min-w-0 text-left text-xs truncate hover:text-brand transition-colors",
                  r.master && "font-medium",
                )}
              >
                {r.name}
              </button>
              {((r.cli ?? "claude") !== "claude" || r.master) && (
                <span className="text-[8px] px-1 rounded shrink-0 bg-brand/15 text-brand uppercase">
                  {r.cli ?? "claude"}
                </span>
              )}
              <Tooltip label={tr("sidebar.launchWith", "Launch with… (override de skills por-instância)")} side="top" className="shrink-0">
                <button
                  onClick={(e) => { e.stopPropagation(); setLaunchPickerRole(r); }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-brand transition-all"
                >
                  <Settings size={10} />
                </button>
              </Tooltip>
              <Tooltip label={tr("sidebar.editPrompt", "Editar prompt")} side="top" className="shrink-0">
                <button
                  onClick={() => setEditingRole(r)}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-text transition-all"
                >
                  <Pencil size={10} />
                </button>
              </Tooltip>
              {!r.builtin && (
                <Tooltip label={tr("sidebar.deleteRole", "Excluir role")} side="top" className="shrink-0">
                  <button
                    onClick={() => deleteRole(r.id)}
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-danger transition-all"
                  >
                    <X size={10} />
                  </button>
                </Tooltip>
              )}
            </div>
          ))}
        </div>
      )}

      {preview &&
        createPortal(
          <div
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4"
            onClick={() => setPreview(null)}
          >
            <div
              className="w-full max-w-md rounded-lg border border-border bg-surface shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <FileUp size={14} className="text-brand" />
                  {tr("roles.previewTitle", "Importar agente como Role")}
                </div>
                <button onClick={() => setPreview(null)} className="text-textMuted hover:text-text">
                  <X size={16} />
                </button>
              </div>
              <div className="space-y-3 px-4 py-3">
                <div>
                  <label className="text-[11px] text-textMuted">{tr("roles.previewName", "Nome")}</label>
                  <div className="text-sm font-medium">{preview.name}</div>
                  {preview.description && (
                    <div className="mt-0.5 text-xs text-textMuted">{preview.description}</div>
                  )}
                </div>
                <div>
                  <label className="text-[11px] text-textMuted">{tr("roles.previewCli", "CLI (editável)")}</label>
                  <select
                    value={previewCli}
                    onChange={(e) => setPreviewCli(e.target.value)}
                    className="mt-0.5 w-full rounded border border-border bg-surface2 px-2 py-1 text-xs"
                  >
                    {ROLE_CLIS.map((c) => (
                      <option key={c.id} value={c.id}>{c.label}</option>
                    ))}
                  </select>
                  <div className="mt-0.5 text-[10px] text-textMuted">
                    {tr("roles.previewFormat", "Formato detectado:")} {preview.format}
                  </div>
                </div>
                <div>
                  <label className="text-[11px] text-textMuted">{tr("roles.previewPersona", "Persona (prévia)")}</label>
                  <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-border bg-surface2 p-2 text-[11px] text-textMuted">
                    {preview.prompt.slice(0, 600)}
                    {preview.prompt.length > 600 ? "\n…" : ""}
                  </pre>
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">
                <button
                  onClick={() => setPreview(null)}
                  className="rounded px-3 py-1 text-xs text-textMuted hover:text-text"
                >
                  {tr("common.cancel", "Cancelar")}
                </button>
                <button
                  onClick={createFromPreview}
                  className="rounded bg-brand px-3 py-1 text-xs font-medium text-white hover:bg-brand/90"
                >
                  {tr("roles.createRole", "Criar role")}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

/** Botão "baixar modelo" com escolha de formato (codex/claude). */
function DownloadTemplateButton({
  onPick,
  tr,
}: {
  onPick: (kind: "codex" | "claude") => void;
  tr: (key: string, fallback?: string) => string;
}) {
  const [menu, setMenu] = useState(false);
  return (
    <div className="relative">
      <Tooltip label={tr("roles.downloadTemplate", "Baixar modelo de agente (preencher e reimportar)")} side="bottom">
        <button
          onClick={() => setMenu((m) => !m)}
          className="text-textMuted hover:text-brand p-0.5 rounded hover:bg-surface2 transition-colors"
        >
          <Download size={12} />
        </button>
      </Tooltip>
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(false)} />
          <div className="absolute right-0 z-50 mt-1 w-32 rounded border border-border bg-surface py-1 shadow-lg">
            <button
              onClick={() => { setMenu(false); onPick("codex"); }}
              className="block w-full px-3 py-1 text-left text-xs hover:bg-surface2"
            >
              Codex (.toml)
            </button>
            <button
              onClick={() => { setMenu(false); onPick("claude"); }}
              className="block w-full px-3 py-1 text-left text-xs hover:bg-surface2"
            >
              Claude (.md)
            </button>
          </div>
        </>
      )}
    </div>
  );
}
