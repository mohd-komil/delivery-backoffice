'use client';

import { useRef, type ComponentProps } from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogTitle = DialogPrimitive.Title;

export function DialogContent({ className, children, onOpenAutoFocus, onCloseAutoFocus, ...props }: ComponentProps<typeof DialogPrimitive.Content>) {
  const previousFocus = useRef<HTMLElement | null>(null);
  return <DialogPrimitive.Portal><DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/45 backdrop-blur-[2px]" /><DialogPrimitive.Content className={cn('dialog-content fixed z-50 border border-border bg-background text-foreground shadow-xl outline-none', className)} onOpenAutoFocus={(event) => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    onOpenAutoFocus?.(event);
  }} onCloseAutoFocus={(event) => {
    onCloseAutoFocus?.(event);
    if (!event.defaultPrevented && previousFocus.current?.isConnected) { event.preventDefault(); previousFocus.current.focus(); }
  }} {...props}>{children}</DialogPrimitive.Content></DialogPrimitive.Portal>;
}
