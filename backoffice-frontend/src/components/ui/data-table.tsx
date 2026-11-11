'use client';

import { useId, useState, type ReactElement, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { Button } from './button';

export type DataTablePagination = {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  disabled?: boolean;
};

type DataTableProps = {
  caption: string;
  header: ReactNode;
  rows: readonly ReactElement[];
  className?: string;
  containerClassName?: string;
  resetKey?: string;
  emptyRow?: ReactNode;
  pagination?: DataTablePagination;
};

export function TablePagination({ caption, tableId, page, pageSize, total, onPageChange, disabled = false }: DataTablePagination & {
  caption: string;
  tableId: string;
}) {
  const t = useTranslations('dataTable');
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return <nav aria-label={t('navigation', { caption })} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 text-xs">
    <p aria-live="polite" aria-atomic="true" className="text-muted-foreground tabular-nums">{t('range', { first, last, total })}</p>
    <div className="flex flex-wrap items-center gap-2">
      <span className="mr-1 text-muted-foreground tabular-nums">{t('page', { page, pages: pageCount })}</span>
      <Button type="button" variant="outline" size="sm" className="min-h-11 min-w-11 sm:min-h-9" aria-label={t('previousPage')} aria-controls={tableId}
        disabled={disabled || page <= 1 || total === 0} onClick={() => onPageChange(page - 1)}>{t('previous')}</Button>
      <Button type="button" variant="outline" size="sm" className="min-h-11 min-w-11 sm:min-h-9" aria-label={t('nextPage')} aria-controls={tableId}
        disabled={disabled || page >= pageCount || total === 0} onClick={() => onPageChange(page + 1)}>{t('next')}</Button>
    </div>
  </nav>;
}

export function DataTable({ caption, header, rows, className, containerClassName, resetKey, emptyRow, pagination }: DataTableProps) {
  const tableId = useId();
  const [clientPagination, setClientPagination] = useState({ page: 1, resetKey });
  const pageSize = pagination?.pageSize ?? 10;
  const total = pagination?.total ?? rows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const clientPage = resetKey === clientPagination.resetKey ? Math.min(clientPagination.page, pageCount) : 1;
  const page = pagination?.page ?? clientPage;

  // Persist a smaller page before rendering children: later refreshes must not restore an out-of-range page.
  if (!pagination && (clientPagination.page !== clientPage || clientPagination.resetKey !== resetKey)) {
    setClientPagination({ page: clientPage, resetKey });
  }

  const visibleRows = pagination ? rows : rows.slice((page - 1) * pageSize, page * pageSize);
  const onPageChange = pagination?.onPageChange ?? ((nextPage: number) => setClientPagination({ page: nextPage, resetKey }));

  return <>
    <div className={cn('table-wrap', containerClassName)}>
      <table id={tableId} className={className}>
        <caption className="sr-only">{caption}</caption>
        <thead>{header}</thead>
        <tbody>{visibleRows.length > 0 ? visibleRows : emptyRow}</tbody>
      </table>
    </div>
    <TablePagination caption={caption} tableId={tableId} page={page} pageSize={pageSize} total={total} onPageChange={onPageChange} disabled={pagination?.disabled} />
  </>;
}
