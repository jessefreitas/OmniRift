import { invoke } from "@tauri-apps/api/core";

export type ServiceCategory =
  | "payment"
  | "consultation"
  | "process"
  | "proposal"
  | "quote"
  | "internal"
  | "other";

export type ServiceExecutionMode = "catalog" | "auto" | "approval";

export interface CompanyServiceOperation {
  id: string;
  name: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  inputSchema: Record<string, unknown>;
  executionMode: ServiceExecutionMode;
}

export interface CompanyService {
  id: string;
  name: string;
  category: ServiceCategory;
  description: string;
  baseUrl: string;
  authKind: "none" | "bearer" | "header";
  authHeader: string;
  authPrefix: string;
  credentialProject: string;
  credentialKey: string;
  enabled: boolean;
  operations: CompanyServiceOperation[];
  hasCredential: boolean;
}

export interface CompanyServiceRequest {
  id: string;
  serviceId: string;
  serviceName: string;
  operationId: string;
  operationName: string;
  input: Record<string, unknown>;
  source: string;
  status: string;
  resultPreview?: string | null;
  createdAt: string;
  decidedAt?: string | null;
}

export interface CompanyServiceCallResult {
  requestId: string;
  status: string;
  httpStatus?: number | null;
  body?: unknown;
  durationMs?: number | null;
}

export const companyServicesList = () => invoke<CompanyService[]>("company_services_list");

export const companyServiceSave = (service: CompanyService, credential?: string) =>
  invoke<CompanyService>("company_service_save", { service, credential: credential || null });

export const companyServiceDelete = (id: string) => invoke<void>("company_service_delete", { id });

export const companyServiceCredentialDelete = (id: string) =>
  invoke<void>("company_service_credential_delete", { id });

export const companyServiceRequests = (status?: string) =>
  invoke<CompanyServiceRequest[]>("company_service_requests", { status: status || null });

export const companyServiceRequestDecide = (requestId: string, approve: boolean) =>
  invoke<CompanyServiceCallResult>("company_service_request_decide", { requestId, approve });
