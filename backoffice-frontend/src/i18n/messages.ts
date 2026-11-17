import type { Locale } from './config';
import * as calendar from './messages/calendar';
import * as common from './messages/common';
import * as dataTable from './messages/data-table';
import * as delivery from './messages/delivery';
import * as deliveryFilters from './messages/delivery-filters';
import * as deliveryList from './messages/delivery-list';
import * as directory from './messages/directory';
import * as entranceReview from './messages/entrance-review';
import * as geocoding from './messages/geocoding';
import * as inboxNearby from './messages/inbox-nearby';
import * as inboxGeography from './messages/inbox-geography';
import * as inboxMap from './messages/inbox-map';
import * as pageHelp from './messages/page-help';
import * as routes from './messages/routes';
import * as workspace from './messages/workspace';
import * as workPlan from './messages/work-plan';
import * as workQuantities from './messages/work-quantities';
import * as workTimes from './messages/work-times';
import * as workTimeAdjustments from './messages/work-time-adjustments';
import * as priorWork from './messages/prior-work';
import * as sourceReview from './messages/source-review';
import * as dispatcher from './messages/dispatcher';
import * as planning from './messages/planning';
import * as operationsFlow from './messages/operations-flow';
import * as routeChecks from './messages/route-checks';
import * as routePublication from './messages/route-publication';
import * as routeOperations from './messages/route-operations';
import * as signatureRefusal from './messages/signature-refusal';

export function messagesForLocale(locale: Locale) {
  return {
    calendar: calendar[locale],
    common: common[locale],
    dataTable: dataTable[locale],
    delivery: delivery[locale],
    deliveryFilters: deliveryFilters[locale],
    deliveryList: deliveryList[locale],
    directory: directory[locale],
    entranceReview: entranceReview[locale],
    geocoding: geocoding[locale],
    inboxNearby: inboxNearby[locale],
    inboxGeography: inboxGeography[locale],
    inboxMap: inboxMap[locale],
    pageHelp: pageHelp[locale],
    routes: routes[locale],
    workspace: workspace[locale],
    workPlan: workPlan[locale],
    workQuantities: workQuantities[locale],
    workTimes: workTimes[locale],
    workTimeAdjustments: workTimeAdjustments[locale],
    priorWork: priorWork[locale],
    sourceReview: sourceReview[locale],
    dispatcher: dispatcher[locale],
    planning: planning[locale],
    operationsFlow: operationsFlow[locale],
    routeChecks: routeChecks[locale],
    routePublication: routePublication[locale],
    routeOperations: routeOperations[locale],
    signatureRefusal: signatureRefusal[locale],
  };
}

declare module 'next-intl' {
  interface AppConfig {
    Locale: Locale;
    Messages: ReturnType<typeof messagesForLocale>;
  }
}

