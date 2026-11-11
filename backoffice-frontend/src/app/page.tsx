import { Backoffice } from '@/components/backoffice';
import { views, workspaceSections } from '@/lib/contracts';

export default async function HomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const section = workspaceSections.find((entry) => entry === query.section) ?? 'deliveries';
  const view = views.find((entry) => entry.id === query.view)?.id ?? 'inbox';
  return <Backoffice initialSection={section} initialView={view} initialDirectoryTab={query.tab === 'participants' ? 'participants' : 'crews'} />;
}
