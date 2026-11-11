import type { Locale } from './config';
import * as calendar from './messages/calendar';
import * as common from './messages/common';
import * as dataTable from './messages/data-table';
import * as delivery from './messages/delivery';
import * as deliveryList from './messages/delivery-list';
import * as directory from './messages/directory';
import * as entranceReview from './messages/entrance-review';
import * as inboxNearby from './messages/inbox-nearby';
import * as inboxGeography from './messages/inbox-geography';
import * as inboxMap from './messages/inbox-map';
import * as pageHelp from './messages/page-help';
import * as routes from './messages/routes';
import * as workspace from './messages/workspace';
import * as workPlan from './messages/work-plan';
import * as operationsFlow from './messages/operations-flow';
import * as routeChecks from './messages/route-checks';
import * as routePublication from './messages/route-publication';

export function messagesForLocale(locale: Locale) {
  return {
    calendar: calendar[locale],
    common: common[locale],
    dataTable: dataTable[locale],
    delivery: delivery[locale],
    deliveryList: deliveryList[locale],
    directory: directory[locale],
    entranceReview: entranceReview[locale],
    inboxNearby: inboxNearby[locale],
    inboxGeography: inboxGeography[locale],
    inboxMap: inboxMap[locale],
    pageHelp: pageHelp[locale],
    routes: routes[locale],
    workspace: workspace[locale],
    workPlan: workPlan[locale],
    operationsFlow: operationsFlow[locale],
    routeChecks: routeChecks[locale],
    routePublication: routePublication[locale],
  };
}

declare module 'next-intl' {
  interface AppConfig {
    Locale: Locale;
    Messages: ReturnType<typeof messagesForLocale>;
  }
}

