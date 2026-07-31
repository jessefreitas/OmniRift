import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { AnyWorkspaceFile, WorkspaceFileV3 } from "@/types/workspace";

export async function saveWorkspace(
  ws: WorkspaceFileV3,
  dir?: string | null
): Promise<string | null> {
  const fileName = `${ws.name || "workspace"}.omnirift.json`;
  let defaultPath = fileName;

  if (dir) {
    // Abrir na pasta do projeto evita que o usuário tenha que procurar onde salvar
    const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
    const trimmedDir = dir.replace(/[\\/]+$/, "");
    defaultPath = trimmedDir ? `${trimmedDir}${sep}${fileName}` : fileName;
  }

  const path = await save({
    title: "Salvar workspace",
    defaultPath,
    filters: [{ name: "OmniRift Workspace", extensions: ["json"] }],
  });
  if (!path) return null;
  await invoke("workspace_save", { path, content: JSON.stringify(ws, null, 2) });
  return path;
}

export async function loadWorkspaceFromDisk(): Promise<AnyWorkspaceFile | null> {
  const path = await open({
    title: "Abrir workspace",
    multiple: false,
    filters: [{ name: "OmniRift Workspace", extensions: ["json"] }],
  });
  if (!path || typeof path !== "string") return null;
  const content = await invoke<string>("workspace_load", { path });
  return JSON.parse(content) as AnyWorkspaceFile;
}
