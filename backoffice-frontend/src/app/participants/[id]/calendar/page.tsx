import { notFound } from 'next/navigation';
import { z } from 'zod';
import { Backoffice } from '@/components/backoffice';

export default async function ParticipantCalendarPage({ params }: { params: Promise<{ id: string }> }) {
  const route = z.object({ id: z.uuid() }).safeParse(await params);
  if (!route.success) notFound();
  const participantId = route.data.id.toLowerCase();
  return <Backoffice key={participantId} participantId={participantId} />;
}
