import React, { useEffect, useRef } from 'react';

interface TerminalNodeProps {
  sessionId: string;
  onOutput?: (data: string) => void;
}

export function TerminalNode({ sessionId, onOutput }: TerminalNodeProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Phase 1: xterm.js init goes here
    // Will call Tauri command pty_spawn and stream output
  }, [sessionId]);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        background: '#000',
        borderRadius: '6px',
        overflow: 'hidden',
        fontFamily: 'monospace',
        fontSize: '13px',
      }}
    />
  );
}
