// orchestration-doctor-client.ts — M4 doctor (Tauri invoke).

import { invoke } from "@tauri-apps/api/core";

export type DoctorCheck = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  hint?: string;
};

export type DoctorReport = {
  checks: DoctorCheck[];
  ok: boolean;
};

export async function orchestrationDoctor(cwd?: string | null): Promise<DoctorReport> {
  return invoke<DoctorReport>("orchestration_doctor", {
    cwd: cwd?.trim() ? cwd : null,
  });
}
