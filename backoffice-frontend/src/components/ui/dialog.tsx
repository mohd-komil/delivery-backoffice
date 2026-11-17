'use client';

import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogTitle = DialogPrimitive.Title;
export const DialogClose = DialogPrimitive.Close;
export const DialogTrigger = DialogPrimitive.Trigger;

const exitDuration = 180;

// Keep conditionally rendered dialogs mounted until the Radix exit animation ends.
// Mutation callbacks still run immediately; only removing the dismissed UI waits.
function useDialogTransition(onClosed: () => void) {
  const [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reset = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setClosing(false);
  }, []);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  const close = useCallback(() => {
    if (timer.current !== null) return;
    setClosing(true);
    if (typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { onClosed(); return; }
    timer.current = setTimeout(() => { timer.current = null; onClosed(); }, exitDuration);
  }, [onClosed]);
  return { closing, close, reset };
}

export function useDialogClose(onClosed: () => void) {
  const { closing, close } = useDialogTransition(onClosed);
  return { open: !closing, close };
}

export function useDialogState<T>() {
  const [value, setValue] = useState<T | null>(null);
  const { closing, close, reset } = useDialogTransition(() => setValue(null));
  const change = (next: T | null) => {
    if (next === null) { close(); return; }
    reset();
    setValue(next);
  };
  return [value, change, value !== null && !closing] as const;
}

export function DialogContent({ className, children, onOpenAutoFocus, onCloseAutoFocus, ...props }: ComponentProps<typeof DialogPrimitive.Content>) {
  const previousFocus = useRef<HTMLElement | null>(null);
  return <DialogPrimitive.Portal><DialogPrimitive.Overlay className="dialog-overlay fixed inset-0 z-40 bg-black/45 backdrop-blur-[2px]" /><DialogPrimitive.Content className={cn('dialog-content fixed z-50 border border-border bg-background text-foreground shadow-xl outline-none', className)} onOpenAutoFocus={(event) => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    onOpenAutoFocus?.(event);
  }} onCloseAutoFocus={(event) => {
    onCloseAutoFocus?.(event);
    if (!event.defaultPrevented && previousFocus.current?.isConnected) { event.preventDefault(); previousFocus.current.focus(); }
  }} {...props}>{children}</DialogPrimitive.Content></DialogPrimitive.Portal>;
}
