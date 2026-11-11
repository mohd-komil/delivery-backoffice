import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import type { Delivery, ServiceType } from '@/lib/contracts';

export type DeliveryText = ReturnType<typeof useTranslations<'delivery'>>;

const serviceNames = {
  delivery_only: 'serviceDeliveryOnly',
  delivery_installation: 'serviceDeliveryInstallation',
  installation_only: 'serviceInstallationOnly',
  collection_only: 'serviceCollectionOnly',
} as const satisfies Record<ServiceType, string>;

export function deliveryServiceLabel(t: DeliveryText, service: ServiceType): string {
  return t(serviceNames[service]);
}

export function deliveryServicePlanLabel(t: DeliveryText, delivery: Delivery): string | undefined {
  const { servicePlan, source } = delivery;
  if (!servicePlan) return undefined;
  const overrides = new Map(servicePlan.overrides.map((line) => [line.sourceLineId, line.service]));
  const services = new Set(source.items.map((item) => overrides.get(item.sourceLineId) ?? servicePlan.defaultService));
  if (services.size > 1) return t('mixedServices');
  const service = services.values().next().value ?? servicePlan.defaultService;
  return service ? deliveryServiceLabel(t, service) : t('notProvided');
}

const statusKeys = [
  ["inbox", 'stateInbox'],
  ["planned", 'statePlanned'],
  ["assigned", 'stateAssigned'],
  ["in_progress", 'stateInProgress'],
  ["partially_completed", 'statePartiallyCompleted'],
  ["return_required", 'stateReturnRequired'],
  ["issues", 'stateIssues'],
  ["completed", 'stateCompleted'],
  ["awaiting_closure", 'stateAwaitingClosure'],
  ["booked", 'stateBooked'],
  ["cancelled", 'stateCancelled'],
  ["active", 'stateActive'],
  ["replaced", 'stateReplaced'],
  ["ready", 'stateReady'],
  ["failed", 'stateFailed'],
  ["open", 'stateOpen'],
  ["resolved", 'stateResolved'],
  ["requested", 'stateRequested'],
  ["refused", 'stateRefused'],
  ["unavailable", 'stateUnavailable'],
  ["missing", 'stateMissing'],
  ["available", 'stateAvailable'],
  ["maintenance", 'stateMaintenance'],
  ["out_of_service", 'stateOutOfService'],
  ["disabled", 'stateDisabled'],
  ["low", 'stateLow'],
  ["medium", 'stateMedium'],
  ["high", 'stateHigh'],
  ["indoor", 'stateIndoor'],
  ["outdoor", 'stateOutdoor'],
  ["document", 'stateDocument'],
  ["photo", 'statePhoto'],
  ["evidence", 'stateEvidence'],
  ["damage", 'stateDamage'],
  ["missing_parts", 'stateMissingParts'],
  ["access", 'stateAccess'],
  ["other", 'stateOther'],
  ["assembly", 'stateAssembly'],
  ["operator", 'stateOperator'],
  ["crew", 'stateCrew'],
  ["unknown", 'stateUnknown'],
  ["yes", 'stateYes'],
  ["no", 'stateNo'],
  ["done", 'stateDone'],
  ["pending", 'statePending'],
] as const;
const statusKeysByValue = new Map<string, (typeof statusKeys)[number][1]>(statusKeys);

const auditKeys = [
  ["instructions.updated", 'auditInstructionsUpdated'],
  ["destination_entrance.confirmed", 'auditEntranceConfirmed'],
  ["services.updated", 'auditServicesUpdated'],
  ["appointment.booked", 'auditAppointmentBooked'],
  ["transport.allocated", 'auditTransportAllocated'],
  ["transport.replaced", 'auditTransportReplaced'],
  ["transport.cancelled", 'auditTransportCancelled'],
  ["appointment.assigned", 'auditAppointmentAssigned'],
  ["appointment.customer_confirmed", 'auditCustomerConfirmed'],
  ["appointment.customer_confirmation_reset", 'auditCustomerConfirmationReset'],
  ["appointment.participants_updated", 'auditParticipantsUpdated'],
  ["appointment.participants_revision", 'auditParticipantsRevision'],
  ["appointment.rescheduled", 'auditAppointmentRescheduled'],
  ["appointment.previous_time", 'auditPreviousTime'],
  ["appointment.cancelled", 'auditAppointmentCancelled'],
  ["appointment.cancellation_reason", 'auditCancellationReason'],
  ["issue.opened", 'auditIssueOpened'],
  ["issue.resolved", 'auditIssueResolved'],
  ["return.requested", 'auditReturnRequested'],
  ["issue.notes_updated", 'auditIssueNotesUpdated'],
  ["issue.notes_revision", 'auditIssueNotesRevision'],
  ["return.notes_updated", 'auditReturnNotesUpdated'],
  ["return.notes_revision", 'auditReturnNotesRevision'],
  ["return.resolved", 'auditReturnResolved'],
  ["checklist.waived", 'auditChecklistWaived'],
  ["checklist.crew_updated", 'auditCrewChecklistUpdated'],
  ["appointment.responsible_selected", 'auditVisitResponsibleSelected'],
  ["appointment.responsible_cleared", 'auditVisitResponsibleCleared'],
  ["delivery.completed", 'auditDeliveryCompleted'],
  ["delivery.reopened", 'auditDeliveryReopened'],
  ["file.upload_started", 'auditFileUploadStarted'],
  ["file.uploaded", 'auditFileUploaded'],
  ["source.imported", 'auditSourceImported'],
  ["source.review_required", 'auditSourceReview'],
  ["source.refreshed", 'auditSourceRefreshed'],
  ["source.invalid", 'auditSourceInvalid'],
  ["execution.start_received", 'auditStartReceived'],
  ["execution.started", 'auditExecutionStarted'],
  ["execution.customer_absent", 'customerAbsent'],
  ["execution.issue_received", 'auditIssueReceived'],
  ["issue.crew_reported", 'auditCrewIssueReported'],
  ["execution.return_received", 'auditReturnReceived'],
  ["return.crew_reported", 'auditCrewReturnReported'],
  ["execution.received", 'auditExecutionReceived'],
  ["execution.crew_reported", 'auditCrewExecutionReported'],
  ["evidence.demo_upload_started", 'auditDemoUploadStarted'],
  ["evidence.demo_uploaded", 'auditDemoUploaded'],
] as const;
const auditKeysByValue = new Map<string, (typeof auditKeys)[number][1]>(auditKeys);

const noticeKeys = [
  ["Source picking no longer qualifies or is missing; new planning requires source review", 'sourceReviewWarning'],
  ["Source record is invalid; previous source snapshot retained for review", 'sourceInvalidWarning'],
  ["Source address, orders or quantities changed after booking; review the remaining work", 'sourceChangedWarning'],
  ["Source requires review; delivery scope is not confirmed", 'blockerSource'],
  ["Delivery has no confirmed item scope", 'blockerEmpty'],
  ["Mandatory checklist items remain incomplete", 'blockerChecklist'],
  ["Open issues remain", 'blockerIssues'],
  ["Unresolved return visit requests remain", 'blockerReturns'],
  ["Unfinished appointments remain", 'blockerUnfinished'],
  ["At least one completed visit is required", 'blockerVisitNeeded'],
] as const;
const noticeKeysByValue = new Map<string, (typeof noticeKeys)[number][1]>(noticeKeys);

const remainingWorkNotices = [
  ['Remaining quantity: ', 'blockerQuantity'],
  ['Remaining installation: ', 'blockerInstallation'],
  ['Remaining collection: ', 'blockerCollection'],
] as const;
const excessWorkNotices = [
  ['Delivered quantity exceeds current source scope: ', 'blockerExcess'],
  ['Installed quantity exceeds current service scope: ', 'blockerInstallationExcess'],
  ['Collected quantity exceeds current service scope: ', 'blockerCollectionExcess'],
] as const;

export function deliveryStatusLabel(t: DeliveryText, state: string): string {
  const key = statusKeysByValue.get(state);
  return key ? t(key) : state.replaceAll('_', ' ');
}

export function deliveryAuditLabel(t: DeliveryText, action: string): string {
  const key = auditKeysByValue.get(action);
  return key ? t(key) : action.replaceAll('_', ' ').replaceAll('.', ' › ');
}

/** Adapt the recognized diagnostics in the existing delivery detail response. */
export function deliveryNoticeLabel(t: DeliveryText, message: string): string {
  const key = noticeKeysByValue.get(message);
  if (key) return t(key);

  for (const [prefix, label] of remainingWorkNotices) {
    if (message.startsWith(prefix)) return t(label, { details: message.slice(prefix.length) });
  }

  for (const [prefix, label] of excessWorkNotices) {
    if (message.startsWith(prefix)) return t(label, { item: message.slice(prefix.length) });
  }

  const visit = /^Visit (\S+) (.+)$/u.exec(message);
  const id = visit?.[1];
  if (id) {
    switch (visit[2]) {
      case 'has no result':
        return t('blockerMissingResult', { id });
      case 'requires the customer signature':
        return t('blockerCustomerSignature', { id });
      case 'requires the responsible crew signature':
        return t('blockerCrewSignature', { id });
    }
  }

  return message;
}

const paths = {
  location: 'M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z M15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  customer: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  package: 'm12 3 9 5-9 5-9-5 9-5Z M3 8v9l9 5 9-5V8 M12 13v9 M7.5 5.5l9 5',
  calendar: 'M8 2v4 M16 2v4 M3 10h18 M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2 M8 14h2 M14 14h2 M8 18h2',
  alert: 'm12 3 10 18H2L12 3Z M12 9v4 M12 17h.01',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z M14 2v6h6 M8 13h8 M8 17h5',
  history: 'M3 12a9 9 0 1 0 2.6-6.4L3 8 M3 3v5h5 M12 7v5l3 2',
  instructions: 'M9 5H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-4 M9 3h6v4H9V3Z M7 12h10 M7 17h6',
  shield: 'm12 3 9 4v6c0 5-9 9-9 9s-9-4-9-9V7l9-4Z m-4 9 3 3 5-6',
  crew: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M22 21v-2a4 4 0 0 0-3-3.9 M17 3.1a4 4 0 0 1 0 7.8',
  clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 7v5l3 2',
  truck: 'M1 4h13v13H1V4Z M14 9h4l4 4v4h-8 M8 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0 M20 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
  check: 'm5 12 4 4L19 6',
} satisfies Record<string, string>;

export type DetailIconName = keyof typeof paths;

export function DetailIcon({ name, className = '' }: { name: DetailIconName; className?: string }) {
  return <svg className={`detail-icon ${className}`} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]} /></svg>;
}

export function DetailHeading({ icon, children, tone = 'info' }: { icon: DetailIconName; children: ReactNode; tone?: 'info' | 'warning' | 'success' | 'neutral' }) {
  return <h3 className="detail-heading"><span className={`detail-heading-icon ${tone}`}><DetailIcon name={icon} /></span>{children}</h3>;
}

/** Presentation of the existing delivery progress; no scheduling rules live here. */
export function ProgressBadge({ progress }: { progress: string }) {
  const t = useTranslations('delivery');
  const tone = progress === 'completed' ? 'success' : ['issues', 'return_required', 'partially_completed', 'awaiting_closure'].includes(progress) ? 'warning' : ['planned', 'assigned', 'in_progress'].includes(progress) ? 'info' : 'neutral';
  return <span className={`badge ${tone}`}><DetailIcon name={tone === 'success' ? 'check' : tone === 'warning' ? 'alert' : 'calendar'} />{deliveryStatusLabel(t, progress)}</span>;
}
