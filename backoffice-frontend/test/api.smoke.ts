import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { API_URL, apiRequest, ApiError } from '../src/lib/api';
import { calendarPeriodDays, calendarPeriodRange } from '../src/lib/calendar-period';
import { appointmentParticipantsSchema, calendarSchema, crewSchema, deliveryListSchema, detailSchema, importSchema, participantCalendarSchema, participantSchema, skillSchema, templateSchema, transportAvailabilitySchema, userSchema, vehicleSchema, views } from '../src/lib/contracts';

void test('live frontend contracts validate authenticated backend and private delivery reads', async () => {
  const filename = process.env.BACKOFFICE_DEMO_ACCOUNTS ?? resolve('../backoffice-backend/.local/demo-accounts.json');
  const raw: unknown = JSON.parse(await readFile(filename, 'utf8'));
  const accounts = z.object({ operator: z.object({ email: z.email(), password: z.string() }) }).parse(raw);
  const login = await fetch(`${API_URL}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:3000' },
    body: JSON.stringify(accounts.operator),
  });
  assert.equal(login.status, 201);
  const loginRaw: unknown = await login.json();
  assert.equal(userSchema.parse(loginRaw).role, 'operator');
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'Login must set a session cookie');
  const options = { headers: { Cookie: cookie } };
  try {
    const monthDays = calendarPeriodDays('2026-11-03', 'month');
    assert.equal(monthDays.length, 42);
    const calendarQuery = new URLSearchParams(calendarPeriodRange(monthDays));
    const [user, deliveries, crews, templates, imports, calendar, participants, skills, vehicles] = await Promise.all([
      apiRequest('/auth/me', userSchema, options),
      apiRequest('/deliveries?view=inbox&page=1', deliveryListSchema, options),
      apiRequest('/crews', z.array(crewSchema), options),
      apiRequest('/templates', z.array(templateSchema), options),
      apiRequest('/imports', z.array(importSchema), options),
      apiRequest(`/calendar?${calendarQuery}`, calendarSchema, options),
      apiRequest('/participants', z.array(participantSchema), options),
      apiRequest('/skills', z.array(skillSchema), options),
      apiRequest('/vehicles', z.array(vehicleSchema), options),
    ]);
    assert.equal(user.role, 'operator');
    assert.ok(deliveries.total >= 1, 'Run the backend import before this live check');
    assert.ok(crews.length >= 1);
    assert.ok(templates.length >= 1);
    assert.ok(imports.length >= 1);
    assert.ok(Array.isArray(calendar));
    assert.ok(Array.isArray(vehicles));
    assert.ok(participants.length >= 1);
    const skillIds = new Set(skills.map((skill) => skill.id));
    assert.ok(participants.every((participant) => participant.skillIds.every((id) => skillIds.has(id))), 'Participant grants must reference the actual skill catalog');
    assert.ok(templates.every((template) => template.requiredSkillIds.every((id) => skillIds.has(id))), 'Template requirements must reference the actual skill catalog');
    const participantIds = new Set(participants.map((participant) => participant.id));
    assert.ok(crews.every((crew) => crew.people.every((person) => participantIds.has(person.id))), 'Every default roster person must reference a real independent participant');
    const assignedParticipant = calendar.flatMap((entry) => entry.appointment.assignments.flatMap((assignment) => assignment.people)).find((person) => participantIds.has(person.id));
    const selectedParticipant = assignedParticipant ?? participants[0];
    assert.ok(selectedParticipant);
    const participantCalendarResponse = await fetch(`${API_URL}/participants/${selectedParticipant.id}/calendar?${calendarQuery}`, options);
    assert.equal(participantCalendarResponse.status, 200);
    const participantCalendarRaw: unknown = await participantCalendarResponse.json();
    const calendarProfile = z.object({ participant: z.record(z.string(), z.unknown()) }).parse(participantCalendarRaw).participant;
    for (const credential of ['login', 'hasPassword', 'password', 'passwordHash', 'password_hash']) assert.equal(Object.hasOwn(calendarProfile, credential), false, 'Participant calendars must omit credential fields at the HTTP boundary');
    assert.equal(Object.hasOwn(calendarProfile, 'skillIds'), false, 'The public calendar profile keeps its existing projection');
    const participantCalendar = participantCalendarSchema.parse(participantCalendarRaw);
    assert.equal(participantCalendar.participant.id, selectedParticipant.id);
    assert.ok(participantCalendar.entries.every((entry) => entry.assignment.people.some((person) => person.id === selectedParticipant.id)), 'Every participant-calendar entry must contain the selected person in its actual assignment snapshot');
    const booked = calendar.find((entry) => entry.appointment.status === 'booked');
    if (booked) {
      const availability = await apiRequest(`/deliveries/${booked.deliveryId}/appointments/${booked.appointment.id}/participants`, appointmentParticipantsSchema, options);
      assert.ok(availability.people.every((person) => participantIds.has(person.id)));
      const transportAvailability = await apiRequest(`/deliveries/${booked.deliveryId}/appointments/${booked.appointment.id}/transport/availability?${new URLSearchParams({ from: booked.appointment.startsAt, to: booked.appointment.endsAt })}`, transportAvailabilitySchema, options);
      const vehicleIds = new Set(vehicles.map((vehicle) => vehicle.id));
      assert.ok(transportAvailability.vehicles.every((vehicle) => vehicleIds.has(vehicle.id)));
      assert.ok(transportAvailability.people.every((person) => participantIds.has(person.id)));
    }
    const first = deliveries.items[0];
    assert.ok(first);
    const detail = await apiRequest(`/deliveries/${first.id}`, detailSchema, options);
    assert.equal(detail.delivery.id, first.id);
    assert.equal(detail.delivery.source.pickingId, first.source.pickingId);
    if (process.env.BACKOFFICE_READONLY_SMOKE !== '1') {
      const save = await fetch(`${API_URL}/deliveries/${first.id}/instructions`, {
      method: 'PATCH', headers: { Cookie: cookie, Origin: 'http://127.0.0.1:3000', 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: detail.delivery.version, ...detail.delivery.instructions }),
    });
    assert.equal(save.ok, true);
    const savedRaw: unknown = await save.json();
      assert.equal(detailSchema.parse(savedRaw).delivery.version, detail.delivery.version + 1);
    }

    const allDeliveries = new Map(deliveries.items.map((delivery) => [delivery.id, delivery]));
    const groups = await Promise.all(views.map((view) => apiRequest(`/deliveries?view=${view.id}&page=1`, deliveryListSchema, options)));
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      const view = views[index];
      assert.ok(group && view);
      for (const delivery of group.items) allDeliveries.set(delivery.id, delivery);
      for (let page = 2; page <= Math.ceil(group.total / group.pageSize); page += 1) {
        const nextPage = await apiRequest(`/deliveries?view=${view.id}&page=${page}`, deliveryListSchema, options);
        for (const delivery of nextPage.items) allDeliveries.set(delivery.id, delivery);
      }
    }
    assert.equal(allDeliveries.size, 20, 'The deterministic fake source imports exactly 20 eligible pickings');
    const details = await Promise.all([...allDeliveries.keys()].map((id) => apiRequest(`/deliveries/${id}`, detailSchema, options)));
    const completed = details.find((entry) => entry.delivery.completedAt !== null);
    assert.ok(completed, 'Run the backend demo scenario before the live frontend check');
    assert.equal(completed.progress, 'completed');
    assert.equal(completed.closureBlockers.length, 0);
    assert.ok(completed.delivery.appointments.flatMap((appointment) => appointment.results).some((result) => result.customerSignature?.status === 'signed' && result.crewSignature?.status === 'signed'));
    const withFile = details.find((entry) => entry.files.some((file) => file.status === 'ready'));
    assert.ok(withFile, 'The backend demo should include a private document/evidence file');
    const file = withFile.files.find((entry) => entry.status === 'ready');
    assert.ok(file);
    const downloadPath = `/deliveries/${withFile.delivery.id}/files/${file.id}`;
    const download = await fetch(`${API_URL}${downloadPath}`, options);
    assert.equal(download.status, 200);
    assert.equal((await download.arrayBuffer()).byteLength, file.size);
    assert.equal(download.headers.get('content-type')?.split(';')[0], file.mime);
    assert.equal(download.headers.get('cross-origin-resource-policy'), 'same-site');
    assert.equal((await fetch(`${API_URL}${downloadPath}`)).status, 401);
    const other = details.find((entry) => entry.delivery.id !== withFile.delivery.id);
    assert.ok(other);
    assert.equal((await fetch(`${API_URL}/deliveries/${other.delivery.id}/files/${file.id}`, options)).status, 404);
    for (const entry of details) {
      for (const unavailable of entry.files.filter((candidate) => candidate.status !== 'ready')) {
        assert.equal((await fetch(`${API_URL}/deliveries/${entry.delivery.id}/files/${unavailable.id}`, options)).status, 404);
      }
    }
    await assert.rejects(apiRequest(`/deliveries/${first.id}`, detailSchema), (error: unknown) => error instanceof ApiError && error.status === 401);
  } finally {
    const logout = await fetch(`${API_URL}/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: 'http://127.0.0.1:3000', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(logout.ok, true);
  }
});
