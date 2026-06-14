// src/components/ErrorBoundary.tsx
//
// Isola falhas de um node: se um node der erro (ex. o tldraw do Sketch falhar ao
// carregar), só ele mostra o fallback — o resto do canvas continua de pé.
// Precisa ser class component (componentDidCatch não tem equivalente em hook).

import { Component, type ReactNode } from "react";

interface Props {
  fallback: ReactNode;
  children: ReactNode;
}

export class ErrorBoundary extends Component<Props, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[ErrorBoundary] node falhou:", error);
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}
