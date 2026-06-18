// src/components/GitReposModal.tsx
//
// Conexões Git: token do provider (GitHub/Forgejo) → lista teus repos → abre um
// como PROJETO (clona via Rust → multi-projeto). O loop "do git ao app".

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { GitFork, Lock, RefreshCw, X } from "lucide-react";

import {
  gitListRepos, gitClone, loadGitProviders, saveGitProvider, loadCloneDir, saveCloneDir,
  GIT_PRESETS, type GitProviderConfig, type GitProviderKind, type RemoteRepo,
} from "@/lib/git-providers";
import { githubDeviceStart, githubDevicePoll, loadGithubClientId, saveGithubClientId } from "@/lib/github-auth-client";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { serenaEnsureProject } from "@/lib/serena-client";
import { useCanvasStore } from "@/store/canvas-store";
import { useT } from "@/lib/i18n";

interface Props {
  onClose: () => void;
}

export function GitReposModal({ onClose }: Props) {
  const t = useT();
  const addProject = useCanvasStore((s) => s.addProject);
  const saved = loadGitProviders();
  const first = saved[0];
  const [kind, setKind] = useState<GitProviderKind>(first?.kind ?? "github");
  const [baseUrl, setBaseUrl] = useState(first?.baseUrl ?? GIT_PRESETS[0].baseUrl);
  const [token, setToken] = useState(first?.token ?? "");
  const [repos, setRepos] = useState<RemoteRepo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [clientId, setClientId] = useState(loadGithubClientId());
  const [device, setDevice] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const [authMsg, setAuthMsg] = useState<string | null>(null);

  function applyPreset(id: string) {
    const p = GIT_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setKind(p.kind);
    setBaseUrl(p.baseUrl);
  }

  async function list() {
    const cfg: GitProviderConfig = { kind, baseUrl: baseUrl.trim(), token: token.trim() };
    if (!cfg.token) { setError(t("gitRepos.enterToken", "informe o token")); return; }
    setLoading(true);
    setError(null);
    try {
      const rs = await gitListRepos(cfg);
      setRepos(rs);
      saveGitProvider(cfg); // guarda a conexão que funcionou
    } catch (e) {
      setError(String(e));
      setRepos([]);
    } finally {
      setLoading(false);
    }
  }

  // Lista automático se já tem um provider salvo com token.
  useEffect(() => { if (first?.token) void list(); /* eslint-disable-next-line */ }, []);

  // OAuth Device Flow: pede o code, abre o navegador, faz poll até o token.
  async function loginGithub() {
    const cid = clientId.trim();
    if (!cid) { setError(t("gitRepos.enterClientId", "Informe o Client ID do seu OAuth App do GitHub (Device Flow habilitado).")); return; }
    saveGithubClientId(cid);
    setError(null); setAuthMsg(null);
    try {
      const d = await githubDeviceStart(cid);
      setDevice({ userCode: d.userCode, verificationUri: d.verificationUri });
      void openUrl(d.verificationUri).catch(() => {});
      const until = Date.now() + d.expiresIn * 1000;
      let interval = Math.max(d.interval, 3);
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, interval * 1000));
        const p = await githubDevicePoll(cid, d.deviceCode);
        if (p.status === "ok" && p.token) {
          setToken(p.token); setDevice(null); setAuthMsg(t("gitRepos.connectedGithub", "✓ conectado ao GitHub"));
          const cfg: GitProviderConfig = { kind: "github", baseUrl: baseUrl.trim(), token: p.token };
          try { setRepos(await gitListRepos(cfg)); saveGitProvider(cfg); } catch (e) { setError(String(e)); }
          return;
        }
        if (p.status === "slow_down") { interval += 5; continue; }
        if (p.status === "error") { setError(p.error ?? t("gitRepos.authDenied", "autorização negada")); setDevice(null); return; }
      }
      setError(t("gitRepos.codeExpired", "o código expirou — tente entrar de novo.")); setDevice(null);
    } catch (e) { setError(String(e)); setDevice(null); }
  }

  async function openRepo(repo: RemoteRepo) {
    let dest = loadCloneDir();
    if (!dest) {
      const sel = await open({ directory: true, multiple: false, title: t("gitRepos.cloneWhere", "Onde clonar os repos?") });
      if (typeof sel !== "string") return;
      dest = sel;
      saveCloneDir(dest);
    }
    setBusy(repo.fullName);
    setError(null);
    try {
      const path = await gitClone(repo.cloneUrl, dest, token.trim() || undefined);
      addProject({ name: repo.name, cwd: path }); // abre como projeto (canvas isolado)
      void serenaEnsureProject(path); // Serena poliglota automático
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  const tokenHint =
    kind === "github"
      ? t("gitRepos.tokenHintGithub", "Crie o token em github.com/settings/tokens (escopo: repo)")
      : kind === "gitlab"
        ? t("gitRepos.tokenHintGitlab", "Crie o token em gitlab.com → Access Tokens (escopos: read_api, read_repository)")
        : t("gitRepos.tokenHintForgejo", "Crie no seu Forgejo/Gitea → Settings → Applications (escopo: repo)");

  const shown = filter.trim()
    ? repos.filter((r) => r.fullName.toLowerCase().includes(filter.trim().toLowerCase()))
    : repos;

  const inp = "px-2 py-1 rounded text-[11px] bg-bg border border-border text-text placeholder:text-textMuted focus:outline-none focus:border-brand";

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-[720px] max-w-[95vw] h-[640px] max-h-[90vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <GitFork size={15} className="text-brand" />
          <span className="text-sm font-medium text-text flex-1">{t("gitRepos.title", "Repositórios Git")}</span>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title={t("common.close", "Fechar")}><X size={16} /></button>
        </header>

        {/* Config do provider */}
        <div className="px-4 py-2.5 border-b border-border space-y-2 shrink-0">
          <div className="flex items-center gap-2">
            <select onChange={(e) => applyPreset(e.target.value)} className={`${inp} w-44`} defaultValue={GIT_PRESETS.find((p) => p.kind === kind && p.baseUrl === baseUrl)?.id ?? ""}>
              <option value="">{t("gitRepos.providerOption", "— provider —")}</option>
              {GIT_PRESETS.map((p) => (<option key={p.id} value={p.id}>{p.label}</option>))}
            </select>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={t("gitRepos.baseUrlPh", "base URL (forgejo)")} className={`${inp} flex-1 font-mono`} />
          </div>
          <div className="flex items-center gap-2">
            <input value={token} onChange={(e) => setToken(e.target.value)} type="password" placeholder={t("gitRepos.tokenPh", "token (com escopo repo)")} className={`${inp} flex-1 font-mono`} />
            <button onClick={() => void list()} disabled={loading || !token.trim()} className="flex items-center gap-1 px-3 py-1 rounded text-[11px] bg-brand text-bg hover:bg-brand-hover disabled:opacity-40">
              <RefreshCw size={11} className={loading ? "animate-spin" : ""} /> {t("gitRepos.listRepos", "Listar repos")}
            </button>
          </div>
          {kind === "github" && (
            <div className="flex items-center gap-2">
              <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={t("gitRepos.clientIdPh", "Client ID do OAuth App (Device Flow)")} className={`${inp} flex-1 font-mono`} />
              <button onClick={() => void loginGithub()} disabled={!!device} className="px-3 py-1 rounded text-[11px] bg-surface2 text-text hover:text-brand border border-border disabled:opacity-40">
                {t("gitRepos.loginGithub", "Entrar com GitHub")}
              </button>
            </div>
          )}
          {device && (
            <div className="rounded border border-brand/40 bg-brand/10 px-3 py-2 text-[11px] text-text">
              {t("gitRepos.deviceOpen", "Abra")}{" "}
              <button onClick={() => void openUrl(device.verificationUri)} className="underline text-brand">{device.verificationUri}</button>{" "}
              {t("gitRepos.devicePaste", "e cole o código:")} <span className="font-mono font-bold tracking-widest">{device.userCode}</span>
              <span className="block opacity-60 mt-0.5">{t("gitRepos.deviceWaiting", "aguardando autorização…")}</span>
            </div>
          )}
          {authMsg && <p className="text-[11px] text-green-400">{authMsg}</p>}
          {error && <p className="text-[11px] text-danger break-words">{error}</p>}
          <p className="text-[10px] text-textMuted opacity-60">🔑 {tokenHint}{kind === "github" ? t("gitRepos.deviceFlowHint", " · ou use o Device Flow (precisa de um OAuth App com client_id)") : ""}</p>
        </div>

        {/* Lista de repos */}
        <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border shrink-0">
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("gitRepos.filterPh", "filtrar…")} className={`${inp} flex-1`} />
          <span className="text-[10px] text-textMuted opacity-60">{shown.length} {t("gitRepos.repoCount", "repo(s)")}</span>
        </div>
        <div className="flex-1 overflow-auto">
          {shown.length === 0 ? (
            <p className="px-4 py-3 text-[12px] text-textMuted opacity-60">{loading ? t("common.loading", "Carregando…") : t("gitRepos.empty", "Conecte um provider e clique 'Listar repos'.")}</p>
          ) : (
            shown.map((r) => (
              <div key={r.fullName} className="flex items-center gap-2 px-4 py-2 border-b border-border/40">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12px] text-text truncate">{r.fullName || r.name}</span>
                    {r.private && <Lock size={10} className="text-yellow-400/70 shrink-0" />}
                    <span className="text-[9px] text-textMuted opacity-50">{r.defaultBranch}</span>
                  </div>
                  {r.description && <p className="text-[10px] text-textMuted opacity-60 truncate">{r.description}</p>}
                </div>
                <button
                  onClick={() => void openRepo(r)}
                  disabled={busy === r.fullName}
                  className="shrink-0 px-2.5 py-1 rounded text-[11px] bg-surface2 text-text hover:text-brand border border-border hover:border-brand disabled:opacity-40 transition-colors"
                >
                  {busy === r.fullName ? t("gitRepos.cloning", "clonando…") : t("gitRepos.openAsProject", "Abrir como projeto")}
                </button>
              </div>
            ))
          )}
        </div>
        <footer className="px-4 py-1.5 border-t border-border text-[10px] text-textMuted opacity-60 shrink-0">
          {t("gitRepos.footer1", "\"Abrir como projeto\" clona o repo e abre como um")} <b>{t("gitRepos.footerProject", "projeto")}</b> {t("gitRepos.footer2", "(canvas isolado). Token em localStorage (keychain = fase futura).")}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
