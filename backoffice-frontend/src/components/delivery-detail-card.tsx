import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader } from './ui/card';
import { DetailHeading, type DetailIconName } from './delivery-detail-presentation';
import { cn } from '@/lib/utils';

export function DeliveryDetailCard({ title, icon, badge, children, tone = 'info', className }: {
  title: string;
  icon: DetailIconName;
  badge?: ReactNode;
  children: ReactNode;
  tone?: 'info' | 'warning' | 'success' | 'neutral';
  className?: string;
}) {
  return <Card role="region" aria-label={title} className={cn('detail-section overview-card', className)}>
    <CardHeader className="overview-card-header flex-row flex-wrap items-center justify-between gap-3 px-5 py-4 max-[500px]:px-4">
      <DetailHeading icon={icon} tone={tone}>{title}</DetailHeading>
      {badge !== undefined ? <span className="badge neutral">{badge}</span> : null}
    </CardHeader>
    <CardContent className="overview-card-content p-5 max-[500px]:p-4">{children}</CardContent>
  </Card>;
}
