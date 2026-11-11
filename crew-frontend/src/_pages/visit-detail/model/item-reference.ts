import type { VisitDetail } from '@/shared/api/contracts';

export function visitItemLabel(item:Pick<VisitDetail['items'][number],'name'|'orderName'|'sourceLineId'>,lineLabel:(line:number)=>string) {
  return [item.name,item.orderName,lineLabel(item.sourceLineId)].filter(Boolean).join(' · ');
}
