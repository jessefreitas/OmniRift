// src/lib/cn.ts
//
// Helper canônico: clsx + tailwind-merge.
// Use sempre que houver class condicional ou override.

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
