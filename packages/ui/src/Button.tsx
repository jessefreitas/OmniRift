import React from 'react';
import { cn } from './utils';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'ghost' | 'destructive';
}

export function Button({ className, variant = 'default', ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors',
        variant === 'default' && 'bg-violet-600 text-white hover:bg-violet-700',
        variant === 'ghost' && 'bg-transparent text-zinc-300 hover:bg-zinc-800',
        variant === 'destructive' && 'bg-red-700 text-white hover:bg-red-800',
        className,
      )}
      {...props}
    />
  );
}
