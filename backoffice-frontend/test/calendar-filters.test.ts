import assert from 'node:assert/strict';
import test from 'node:test';
import { appointmentSchema, type CalendarEntry, type CalendarFilterCatalog } from '../src/lib/contracts';
import { calendarFilterOptions, changeCalendarGeography, filterCalendarEntries, type CalendarFilters } from '../src/lib/calendar-filters';

const crewA = '11000000-0000-4000-8000-000000000001';
const crewB = '11000000-0000-4000-8000-000000000002';
const crewC = '11000000-0000-4000-8000-000000000003';
const all: CalendarFilters = { customerName: '' };
const catalog: CalendarFilterCatalog = {
  destinations: [
    { city: 'Catania', province: 'CT', postalCode: '95121', count: 7 },
    { city: ' Catania ', province: 'CT', postalCode: '95125', count: 3 },
    { city: 'Messina', province: 'ME', postalCode: '98123', count: 11 },
    { city: 'Roma', province: 'RM', postalCode: '00100', count: 1 },
    { city: null, province: null, postalCode: null, count: 3 },
    { city: 'Palermo', province: 'PA', postalCode: '90100', count: 6 },
  ],
  crews: [
    { id: crewA, name: 'Shared team name', enabled: true },
    { id: crewB, name: 'Shared team name', enabled: false },
    { id: crewC, name: 'Unscheduled team', enabled: true },
  ],
};
const emptyCatalog: CalendarFilterCatalog = { destinations: [], crews: [] };

function entry(index: number, geography: CalendarEntry['geography'], crews: string[], customerName: string): CalendarEntry {
  const suffix = String(index).padStart(12, '0');
  return {
    deliveryId: `12000000-0000-4000-8000-${suffix}`, pickingName: `DEMO/CALENDAR/${index}`, customerName, geography,
    appointment: appointmentSchema.parse({ id: `13000000-0000-4000-8000-${suffix}`, startsAt: '2026-11-13T08:00:00Z', endsAt: '2026-11-13T10:00:00Z', status: 'booked', cancellationReason: null, returnRequestId: null, results: [],
      assignments: crews.map((crewId, assignmentIndex) => ({ id: `14000000-0000-4000-8000-${String(index * 10 + assignmentIndex).padStart(12, '0')}`, crewId, crewName: 'Shared team name', people: [], tasks: [] })),
    }),
  };
}

const entries = [
  entry(1, { city: 'Catania', province: 'CT', postalCode: '95121', source: 'odoo' }, [crewA], 'Alice Rossi'),
  entry(2, { city: ' Catania ', province: 'CT', postalCode: '95125', source: 'odoo' }, [crewB], 'Àlice Rossi'),
  entry(3, { city: 'Messina', province: 'ME', postalCode: '98123', source: 'odoo' }, [crewA, crewA, crewB], 'Bruno Greco'),
  entry(4, { city: 'Roma', province: 'RM', postalCode: '00100', source: 'odoo' }, [], 'Carla Rizzo'),
  entry(5, { city: null, province: null, postalCode: null, source: null }, [], 'Unknown destination'),
];

function names(filtered: readonly CalendarEntry[]) { return filtered.map((row) => row.pickingName); }

void test('Calendar combines destination, actual crew identity and partial customer name without mutating entries', () => {
  const filtered = filterCalendarEntries(entries, { city: ' catania ', province: 'ct', postalCode: '95121', crewId: crewA, customerName: ' ALI ' });
  assert.deepEqual(names(filtered), ['DEMO/CALENDAR/1']);
  assert.equal(filtered[0], entries[0]);
  assert.deepEqual(names(filterCalendarEntries(entries, { customerName: 'alice' })), ['DEMO/CALENDAR/1', 'DEMO/CALENDAR/2']);
  assert.deepEqual(names(filterCalendarEntries(entries, { ...all, crewId: crewB })), ['DEMO/CALENDAR/2', 'DEMO/CALENDAR/3'], 'Two teams sharing a name remain different by ID');
  assert.deepEqual(names(filterCalendarEntries(entries, { ...all, crewId: null })), ['DEMO/CALENDAR/4', 'DEMO/CALENDAR/5']);
  assert.deepEqual(names(filterCalendarEntries(entries, { ...all, city: null })), ['DEMO/CALENDAR/5']);
  assert.equal(entries[1]?.geography?.city, ' Catania ');
});

void test('Calendar uses all catalogue destinations and teams independently of the period, customer and team filters', () => {
  const options = calendarFilterOptions(catalog, { customerName: 'No matching customer', crewId: crewA, city: 'Catania', province: 'CT' });
  assert.deepEqual(options.cities, [{ value: 'Catania', count: 10 }, { value: 'Messina', count: 11 }, { value: 'Palermo', count: 6 }, { value: 'Roma', count: 1 }, { value: null, count: 3 }]);
  assert.deepEqual(options.provinces, [{ value: 'CT', count: 10 }]);
  assert.deepEqual(options.postalCodes, [{ value: '95121', count: 7 }, { value: '95125', count: 3 }]);
  assert.deepEqual(options.crews, [{ value: crewA, label: 'Shared team name' }, { value: crewB, label: 'Shared team name' }, { value: crewC, label: 'Unscheduled team' }, { value: null, label: null }], 'Disabled teams and teams without appointments remain selectable');
  assert.deepEqual(calendarFilterOptions(catalog, { ...all, crewId: crewA }).cities, calendarFilterOptions(catalog, all).cities);
  assert.deepEqual(calendarFilterOptions(catalog, { customerName: 'carla' }), calendarFilterOptions(catalog, all));
  assert.ok(calendarFilterOptions(catalog, all).postalCodes.some((choice) => choice.value === '00100'), 'Postal codes retain leading zeroes');
  assert.deepEqual(filterCalendarEntries(entries, { ...all, city: 'Palermo' }), [], 'A global choice may have no visits in this period');
});

void test('Explicit geography selection fills sole known values in both directions and clears child choices', () => {
  assert.deepEqual(changeCalendarGeography(catalog, all, 'city', 'Messina'), { customerName: '', city: 'Messina', province: 'ME', postalCode: '98123' });
  assert.deepEqual(changeCalendarGeography(catalog, all, 'province', 'RM'), { customerName: '', city: 'Roma', province: 'RM', postalCode: '00100' });
  assert.deepEqual(changeCalendarGeography(catalog, all, 'postalCode', '95125'), { customerName: '', city: 'Catania', province: 'CT', postalCode: '95125' });
  const old: CalendarFilters = { customerName: '', city: 'Messina', province: 'ME', postalCode: '98123', crewId: crewA, crewName: 'Messina team' };
  assert.deepEqual(changeCalendarGeography(catalog, old, 'city', 'Catania'), { customerName: '', city: 'Catania', province: 'CT', postalCode: undefined, crewId: crewA, crewName: 'Messina team' }, 'Auto-selection follows all destination records, not the chosen crew’s appointments');
  assert.deepEqual(changeCalendarGeography(catalog, { ...all, customerName: 'Nobody' }, 'city', 'Palermo'), { customerName: 'Nobody', city: 'Palermo', province: 'PA', postalCode: '90100' });
  assert.deepEqual(changeCalendarGeography(catalog, { ...all, city: 'Catania', province: 'CT', postalCode: '95125' }, 'postalCode', undefined), { customerName: '', city: 'Catania', province: 'CT', postalCode: undefined });
});

void test('Missing data never fills a field automatically; old API records remain explicitly unknown', () => {
  const missing = { ...emptyCatalog, destinations: [{ city: 'Catania', province: null, postalCode: null, count: 1 }] };
  assert.deepEqual(changeCalendarGeography(missing, all, 'city', 'Catania'), { customerName: '', city: 'Catania', province: undefined, postalCode: undefined });
  const legacy = entry(7, undefined, [], 'Legacy');
  assert.deepEqual(names(filterCalendarEntries([legacy], { ...all, province: null })), ['DEMO/CALENDAR/7']);
  assert.deepEqual(calendarFilterOptions(emptyCatalog, all).cities, [], 'Missing catalogue data does not manufacture choices from current visits');
  assert.deepEqual(names(filterCalendarEntries([legacy], { ...all, city: 'Catania' })), []);
});

void test('Refresh retains selected missing catalogue values and the remembered crew label', () => {
  const selected: CalendarFilters = { city: 'Catania', province: 'CT', postalCode: '95125', crewId: crewA, crewName: 'Original team', customerName: 'Alice' };
  const options = calendarFilterOptions(emptyCatalog, selected);
  assert.deepEqual(options, { cities: [{ value: 'Catania', count: 0 }], provinces: [{ value: 'CT', count: 0 }], postalCodes: [{ value: '95125', count: 0 }], crews: [{ value: crewA, label: 'Original team' }, { value: null, label: null }] });
  assert.deepEqual(selected, { city: 'Catania', province: 'CT', postalCode: '95125', crewId: crewA, crewName: 'Original team', customerName: 'Alice' });
  const caseChanged: CalendarFilterCatalog = { ...emptyCatalog, destinations: [{ city: 'CATANIA', province: 'CT', postalCode: '95125', count: 4 }] };
  assert.deepEqual(calendarFilterOptions(caseChanged, selected).cities, [{ value: 'Catania', count: 4 }]);
});
