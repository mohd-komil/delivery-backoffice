import { VisitDetailScreen } from '@/_pages/visit-detail';

export default async function VisitDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <VisitDetailScreen key={id} visitId={id} />;
}
