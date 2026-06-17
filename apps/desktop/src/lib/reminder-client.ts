// src/lib/reminder-client.ts
//
// Lembretes salvos a partir de notas do canvas — persistem no SQLite (fora do
// canvas), então sobrevivem a trocar de floor/projeto e fechar o app.

import { invoke } from "@tauri-apps/api/core";

export interface Reminder {
  id: number;
  content: string;
  noteId?: string;
  floorId?: string;
  projectId?: string;
  remindAt?: string;
  done: boolean;
  createdAt: string;
}

export interface ReminderInput {
  content: string;
  noteId?: string;
  floorId?: string;
  projectId?: string;
  remindAt?: string;
}

export async function reminderAdd(reminder: ReminderInput): Promise<number> {
  return invoke<number>("reminder_add", { reminder });
}

export async function remindersList(): Promise<Reminder[]> {
  return invoke<Reminder[]>("reminders_list");
}

export async function reminderSetDone(id: number, done: boolean): Promise<void> {
  return invoke("reminder_set_done", { id, done });
}

export async function reminderDelete(id: number): Promise<void> {
  return invoke("reminder_delete", { id });
}
