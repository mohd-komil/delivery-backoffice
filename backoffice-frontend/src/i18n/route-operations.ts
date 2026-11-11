import { en as blockerMessages } from './messages/route-operation-blockers';
import { en as workMessages } from './messages/work-plan';

export function isRouteBlockerKey(value: string | null | undefined): value is keyof typeof blockerMessages {
  return typeof value === 'string' && Object.hasOwn(blockerMessages, value);
}
export function isWorkMessageKey(value: string): value is keyof typeof workMessages {
  return Object.hasOwn(workMessages, value);
}
