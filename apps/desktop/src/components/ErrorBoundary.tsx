// src/components/ErrorBoundary.tsx
//
// Isola falhas de um node: se um node der erro (ex. o tldraw do Sketch falhar ao
// carregar), só ele mostra o fallback — o resto do canvas continua de pé.
// Precisa ser class component (componentDidCatch não tem equivalente em hook).

import { Component, type ErrorInfo, type ReactNode } from "react";

import { logToDisk } from "@/lib/debug-log";

interface Props {
  fallback: ReactNode;
  /** Rótulo da fronteira (ex.: "app", "SketchNode") — vai pro log pra localizar a falha. */
  label?: string;
  children: ReactNode;
}

export class ErrorBoundary extends Component<Props, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] node falhou:", error);
    // P0: grava em DISCO (~/.omnirift/debug.log) — sobrevive à tela preta, ao contrário do
    // console. Inclui o componentStack pra apontar QUAL componente estourou.
    logToDisk(
      `[${new Date().toISOString()}] [💥 REACT-ERROR${this.props.label ? ` @${this.props.label}` : ""}] ${error.message}\n` +
        `stack:\n${error.stack ?? "(sem stack)"}\n` +
        `componentStack:${info.componentStack ?? ""}`,
    );
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}
