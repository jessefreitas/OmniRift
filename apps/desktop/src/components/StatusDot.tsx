import { cn } from "@/lib/cn";
import type { AgentState } from "@/types/pty";

const DOT: Record<AgentState, string> = {
  idle: "bg-green-500",
  working: "bg-yellow-400 animate-pulse",
  blocked: "bg-red-500",
  done: "bg-blue-500",
  dead: "bg-gray-500",
};

const TITLE: Record<AgentState, string> = {
  idle: "ocioso",
  working: "trabalhando",
  blocked: "esperando você",
  done: "concluído",
  dead: "encerrado",
};

interface StatusDotProps {
  status: AgentState;
  size?: number;
  className?: string;
}

export function StatusDot({ status, size = 6, className }: StatusDotProps) {
  return (
    <span
      className={cn("rounded-full shrink-0", DOT[status], className)}
      style={{ width: size, height: size }}
      title={TITLE[status]}
    />
  );
}
