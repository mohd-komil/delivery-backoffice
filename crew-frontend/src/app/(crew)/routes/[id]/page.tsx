import { RouteDetailScreen } from '@/_pages/route-detail';

export default async function RouteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RouteDetailScreen key={id} routeId={id} />;
}
