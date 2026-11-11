/** Display names only. The server decides whether the transition is permitted. */
export function routeBlockerLabel(code: string | null | undefined) {
  if (code === 'ROUTE_VERSION_CHANGED') return 'routeConflict';
  if (code === 'ROUTE_NOT_PUBLISHED' || code === 'ROUTE_NOT_IN_PROGRESS') return 'routeStateChanged';
  if (code === 'ROUTE_NO_PENDING_STOP') return 'noMoreStops';
  if (code === 'ROUTE_HAS_STARTED_WORK') return 'startedWorkReview';
  if (code === 'VISIT_WORK_REVIEW_REQUIRED') return 'workReviewRequired';
  if (code === 'CUSTOMER_CONFIRMATION_REQUIRED') return 'customerConfirmationRequired';
  if (code === 'ROUTE_DEPARTURE_REQUIRED') return 'departureRequired';
  if (code === 'ROUTE_RETURN_REQUIRED') return 'returnOutstanding';
  if (code === 'ROUTE_BUFFER_REQUIRED' || code === 'ROUTE_TURNAROUND_REQUIRED') return 'bufferActive';
  if (code === 'ROUTE_STOP_ORDER_REQUIRED' || code === 'ROUTE_NOT_NEXT_STOP') return 'notNextStop';
  if (code === 'ROUTE_REPORTS_REQUIRED' || code === 'ROUTE_STOPS_UNFINISHED' || code === 'ROUTE_UNFINISHED_STOPS') return 'missingReports';
  if (code === 'NOT_ROUTE_RESPONSIBLE' || code === 'ROUTE_RESPONSIBLE_REQUIRED') return 'responsibleOnly';
  return 'routeNotReady';
}
