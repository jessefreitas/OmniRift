import { invoke } from "@tauri-apps/api/core";

export type KnowledgeKind = "persona" | "council" | "company" | "policy" | "playbook" | "other";

export interface CompanyKnowledgeSummary {
  id: string;
  name: string;
  title: string;
  kind: KnowledgeKind;
  description: string;
  enabled: boolean;
  builtIn: boolean;
  contentBytes: number;
  sourceUrl?: string | null;
  sourceModifiedAt?: string | null;
  updatedAt: string;
}

export interface CompanyKnowledgeSource extends CompanyKnowledgeSummary {
  content: string;
}

export interface CompanyKnowledgeInput {
  id: string;
  name: string;
  title: string;
  kind: KnowledgeKind;
  description: string;
  content: string;
  enabled: boolean;
}

export function companyKnowledgeList(): Promise<CompanyKnowledgeSummary[]> {
  return invoke("company_knowledge_list");
}

export function companyKnowledgeGet(id: string): Promise<CompanyKnowledgeSource> {
  return invoke("company_knowledge_get", { id });
}

export function companyKnowledgeSave(source: CompanyKnowledgeInput): Promise<CompanyKnowledgeSource> {
  return invoke("company_knowledge_save", { source });
}

export function companyKnowledgeDelete(id: string): Promise<void> {
  return invoke("company_knowledge_delete", { id });
}
