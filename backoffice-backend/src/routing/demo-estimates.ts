import { distanceKm } from './calculation';
import { directedRoutePair, type RoutePointCoordinates, type RouteTravelEstimate } from './contracts';

export const demoRouteAddressIds = {
  milano: '91000000-0000-4000-8000-000000000001',
  sesto: '91000000-0000-4000-8000-000000000002',
  monza: '91000000-0000-4000-8000-000000000003',
};

export const routeDepots = [
  // Public reference points from local/public-demo-addresses.json; these are not actual company warehouses.
  { id: 'demo-start-catania', name: 'Catania · Demo start · Orto Botanico', latitude: 37.5154798, longitude: 15.0834923 },
  { id: 'demo-start-messina', name: 'Messina · Demo start · Palazzo Zanca', latitude: 38.1939931, longitude: 15.5555215 },
  { id: 'warehouse-milano', name: 'Milano · Demo depot', latitude: 45.492, longitude: 9.130 },
  { id: 'warehouse-monza', name: 'Monza · Demo depot', latitude: 45.605, longitude: 9.252 },
];

/** Teaching approximation only: no road network, traffic, vehicle restrictions or ferry timetable. */
export function getLocalDemoRouteEstimates(chain: readonly string[], coordinates: ReadonlyMap<string, RoutePointCoordinates>): RouteTravelEstimate[] {
  return chain.slice(1).flatMap((toPointId, index) => {
    const fromPointId = chain[index];
    if (fromPointId === undefined) return [];
    const from = coordinates.get(fromPointId);
    const to = coordinates.get(toPointId);
    if (!from || !to) return [];
    const minutes = Math.ceil(distanceKm(from, to) * 1.3 / 30 * 60);
    // An unsupported leg remains unknown; capping it would understate the route duration.
    return minutes > 1440 ? [] : [{ fromPointId, toPointId, minutes, source: 'local_demo' }];
  });
}

const { milano, sesto, monza } = demoRouteAddressIds;
const demoLegs = [
  ['warehouse-milano', milano, 30], [milano, monza, 20], [monza, 'warehouse-milano', 25],
  ['warehouse-milano', monza, 42], [monza, milano, 28], [milano, 'warehouse-milano', 22],
  [milano, sesto, 14], [sesto, milano, 18], [sesto, monza, 16], [monza, sesto, 15],
  ['warehouse-milano', sesto, 24], [sesto, 'warehouse-milano', 23],
  ['warehouse-monza', milano, 35], [milano, 'warehouse-monza', 34],
  ['warehouse-monza', sesto, 21], [sesto, 'warehouse-monza', 19],
  ['warehouse-monza', monza, 10], [monza, 'warehouse-monza', 12],
] as const;

const minutesByLeg = new Map(demoLegs.map(([from, to, minutes]) => [directedRoutePair(from, to), minutes]));

export function getDemoRouteEstimates(chain: readonly string[]): RouteTravelEstimate[] {
  return chain.slice(1).flatMap((toPointId, index) => {
    const fromPointId = chain[index];
    if (fromPointId === undefined) return [];
    const minutes = minutesByLeg.get(directedRoutePair(fromPointId, toPointId));
    return minutes === undefined ? [] : [{ fromPointId, toPointId, minutes, source: 'demo' }];
  });
}
