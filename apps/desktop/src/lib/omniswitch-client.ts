import { invoke } from "@tauri-apps/api/core";

export interface OmniSwitchUrl { baseUrl: string; token: string }

export const omniswitchUrl = () => invoke<OmniSwitchUrl>("omniswitch_url");
export const omniswitchConfigGet = () => invoke<string>("omniswitch_config_get");
export const omniswitchConfigSet = (json: string) => invoke<void>("omniswitch_config_set", { json });
export const omniswitchHealth = () => invoke<[string, boolean][]>("omniswitch_health");

/** Env de roteamento pro agente: aponta as BASE_URL pro router e usa o token do router
 *  como "API key" do agente (o router valida e injeta a chave real do provider). Só
 *  claude-code/codex — CLIs que respeitam ANTHROPIC_BASE_URL/OPENAI_BASE_URL. */
export async function omniswitchEnv(): Promise<Array<[string, string]>> {
  const { baseUrl, token } = await omniswitchUrl();
  return [
    ["ANTHROPIC_BASE_URL", baseUrl],
    ["ANTHROPIC_API_KEY", token],
    ["OPENAI_BASE_URL", `${baseUrl}/v1`],
    ["OPENAI_API_KEY", token],
  ];
}
