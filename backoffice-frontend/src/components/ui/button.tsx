import type * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// Local shadcn/ui-style source, adapted to this product's Geist tokens.
export const buttonVariants = cva('inline-flex min-h-9 items-center justify-center gap-2 whitespace-nowrap rounded-md text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-45', {
  variants: {
    variant: { default: 'border border-primary bg-primary text-primary-foreground hover:opacity-85', outline: 'border border-input bg-background text-foreground hover:bg-accent', ghost: 'text-muted-foreground hover:bg-accent hover:text-foreground', destructive: 'bg-destructive text-white hover:opacity-85' },
    size: { default: 'px-4 py-2', sm: 'min-h-8 px-3 py-1.5 text-xs', icon: 'h-9 w-9 p-0' },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});

export function Button({ className, variant, size, ...props }: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants>) {
  return <button data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}
