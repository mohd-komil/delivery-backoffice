import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { DataSource, type EntityManager } from 'typeorm';
import { z } from 'zod';
import { applicationUrl } from '../src/config';
import { applicationMigrations, Database, makeDataSource, rows } from '../src/database/database';
import { createDelivery, type Appointment, type ExecutionInput, type SourceSnapshot } from '../src/domain/model';
import { closureBlockers, completeDelivery, confirmCustomerVisit, instantiateTask, planVisitWork, recordExecution, startVisit } from '../src/domain/rules';
import { Files, inspectFile, MAX_FILE_BYTES, validateFileContent } from '../src/evidence/files';
import { Execution } from '../src/execution/execution';
import { Identity, hashPassword } from '../src/identity/identity';
import { Operations } from '../src/operations/operations';
import { Participants } from '../src/operations/participants';
import { Skills } from '../src/operations/skills';
import { Vehicles } from '../src/operations/vehicles';
import { DeliveryStore } from '../src/operations/store';
import { DeliveryPoints } from '../src/operations/delivery-points';

void test('file validation decodes legitimate generated PNG, JPEG and PDF and accepts UTF-8 text', async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 30, g: 50, b: 70 } } }).png().toBuffer();
  const jpeg = await sharp(png).jpeg().toBuffer();
  const document = await PDFDocument.create();
  document.addPage([200, 200]).drawText('DEMO synthetic document');
  const pdf = Buffer.from(await document.save());
  const text = Buffer.from('DEMO — синтетический документ\nNo customer information.\tUTF-8');
  for (const [name, bytes, mime] of [
    ['DEMO photo.png', png, 'image/png'],
    ['DEMO photo.jpeg', jpeg, 'image/jpeg'],
    ['DEMO document.pdf', pdf, 'application/pdf'],
    ['DEMO документ.txt', text, 'text/plain'],
  ] as const) {
    const inspected = inspectFile(name, bytes.toString('base64'));
    assert.equal(inspected.mime, mime);
    assert.deepEqual(inspected.bytes, bytes);
    await validateFileContent(inspected);
  }
});

void test('magic bytes alone do not admit forged JPEG, PNG, PDF or an empty-page PDF', async () => {
  const fakeJpeg = Buffer.from([255, 216, 255, 255, 217]);
  const fakePng = Buffer.alloc(64);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(fakePng);
  fakePng.writeUInt32BE(1, 16);
  fakePng.writeUInt32BE(1, 20);
  Buffer.from('IEND').copy(fakePng, 56);
  const fakePdf = Buffer.from('%PDF-1.7\nDEMO forged PDF without objects or pages\n%%EOF');
  const emptyDocument = await PDFDocument.create();
  const emptyPdf = Buffer.from(await emptyDocument.save({ addDefaultPage: false }));
  for (const [name, bytes] of [['DEMO fake.jpg', fakeJpeg], ['DEMO fake.png', fakePng], ['DEMO fake.pdf', fakePdf], ['DEMO empty.pdf', emptyPdf]] as const) {
    const inspected = inspectFile(name, bytes.toString('base64'));
    await assert.rejects(() => validateFileContent(inspected), BadRequestException);
  }
});

void test('text, filenames, extensions and canonical base64 reject unsafe or malformed input', () => {
  const valid = Buffer.from('DEMO valid text').toString('base64');
  for (const filename of ['../outside.txt', '.hidden.txt', 'invalid\\path.txt', 'payload.exe', 'false-image.png']) {
    assert.throws(() => inspectFile(filename, valid), BadRequestException);
  }
  for (const base64 of ['', 'AA', 'AA===', 'AA==\n', 'AB==', '====', 'not base64!', ' AAAAAA=']) {
    assert.throws(() => inspectFile('DEMO.txt', base64), BadRequestException);
  }
  assert.throws(() => inspectFile('DEMO invalid UTF8.txt', Buffer.from([255]).toString('base64')), BadRequestException);
  assert.throws(() => inspectFile('DEMO control bytes.txt', Buffer.from([65, 0, 66]).toString('base64')), BadRequestException);
});

void test('5 MiB text boundary succeeds, one extra byte returns validation error without recursive-regex RangeError', async () => {
  const exactLimit = Buffer.alloc(MAX_FILE_BYTES, 65);
  const inspected = inspectFile('DEMO boundary.txt', exactLimit.toString('base64'));
  assert.equal(inspected.bytes.length, 5_242_880);
  await validateFileContent(inspected);
  assert.throws(() => inspectFile('DEMO overflow.txt', Buffer.alloc(MAX_FILE_BYTES + 1, 65).toString('base64')), BadRequestException);
});

class FilesDatabase extends Database {
  override readonly source: DataSource;
  constructor(schema: string) {
    super();
    this.source = new DataSource({ type: 'postgres', url: applicationUrl(true), schema, entities: [],
      migrations: applicationMigrations, synchronize: false, logging: false,
      extra: { options: `-c search_path=${schema}` } });
  }
}

function barrier() {
  const state: { release?: () => void } = {};
  const promise = new Promise<void>((resolve) => { state.release = resolve; });
  return { promise, release() {
    if (!state.release) throw new Error('Barrier was not initialized');
    state.release();
  } };
}

/** A typed scheduling seam pauses before the second real locked read; PostgreSQL and filesystem remain real. */
class FinalizationBarrierStore extends DeliveryStore {
  readonly entered = barrier();
  readonly continueRead = barrier();
  private reads = 0;
  constructor(database: Database, private readonly targetId: string) { super(database); }
  override async get(id: string, executor: EntityManager = this.db.source.manager, lock = false) {
    if (id === this.targetId && lock) {
      this.reads += 1;
      if (this.reads === 2) {
        this.entered.release();
        await this.continueRead.promise;
      }
    }
    return super.get(id, executor, lock);
  }
}

void test('private upload on owned PostgreSQL: replay, interruption, close race and lifecycle invariants', async (context) => {
  process.env['BACKOFFICE_TEST'] = '1';
  const schema = `files_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^files_[0-9a-f]{32}$/);
  const admin = makeDataSource(true);
  const database = new FilesDatabase(schema);
  const ownedPhysicalFiles = new Set<string>();
  let schemaCreated = false;
  try {
    await admin.initialize();
    assert.equal((await rows(admin.manager, z.object({ name: z.literal('delivery_backoffice_test') }), 'SELECT current_database() AS name')).length, 1);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await database.onModuleInit();
    await database.source.runMigrations({ transaction: 'all' });
    const store = new DeliveryStore(database);
    const files = new Files(store);
    const identity = new Identity(database);
    const password = randomBytes(24).toString('base64url');
    const principalId = randomUUID();
    await database.source.query('INSERT INTO app_user(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)',
      [principalId, 'files@example.test', 'DEMO authenticated file operator', 'operator', await hashPassword(password)]);
    const login = await identity.login({ email: 'files@example.test', password });
    const principal = await identity.authenticate({ headers: { cookie: 'backoffice_session=' + login.token } });
    const source: SourceSnapshot = {
      pickingId: 1, pickingName: 'FILES/DEMO/0001', saleOrderId: 1, saleOrderName: 'FILES/SO/0001', sourceState: 'assigned', salesTeam: 'MOHD MESSINA',
      customer: { id: 1, name: 'DEMO synthetic customer', address: 'Synthetic Lane 1', city: 'Messina', country: 'IT', phones: ['+390000000001'], email: null, contact: null },
      items: [{ sourceLineId: 10, productId: 1, name: 'DEMO item', description: null, quantity: 1, uom: 'unit', configuration: null, ambient: null, notes: null, photoUrl: null }],
      serviceType: 'delivery_only', estimatedMinutes: null, notes: null,
    };
    const delivery = createDelivery(source, randomUUID());
    await database.source.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)', [delivery.id, schema, 1, delivery.version, JSON.stringify(delivery)]);
    const upload = { requestId: randomUUID(), name: 'DEMO operator document.txt', base64: Buffer.from('DEMO synthetic operator document').toString('base64'), kind: 'document', appointmentId: null, itemId: 10, issueId: null };

    await context.test('identical request produces one ready file, one receipt, one completion audit', async () => {
      ownedPhysicalFiles.add(upload.requestId);
      const first = await files.upload(delivery.id, upload, principal);
      const replay = await files.upload(delivery.id, upload, principal);
      assert.equal(first.files.length, 1);
      assert.equal(replay.files.length, 1);
      assert.equal(replay.files[0]?.id, upload.requestId);
      assert.equal(replay.files[0]?.status, 'ready');
      const receipts = await rows(database.source.manager, z.object({ count: z.string() }), 'SELECT count(*)::text AS count FROM command_receipt WHERE delivery_id=$1 AND request_id=$2', [delivery.id, upload.requestId]);
      assert.equal(receipts[0]?.count, '1');
      assert.equal(replay.history.filter((entry) => entry.action === 'file.uploaded').length, 1);
      assert.equal((await files.download(delivery.id, upload.requestId)).bytes.toString('utf8'), 'DEMO synthetic operator document');
      await assert.rejects(() => files.upload(delivery.id, { ...upload, base64: Buffer.from('DEMO changed content').toString('base64') }, principal), ConflictException);
      assert.equal((await store.detail(delivery.id)).files.length, 1);
    });

    await context.test('a real interrupted filesystem write records failed state and cannot replay as success', async () => {
      const id = randomUUID();
      const pendingName = id + '.pending';
      ownedPhysicalFiles.add(pendingName);
      await mkdir(files.directory, { recursive: true });
      await writeFile(path.join(files.directory, pendingName), 'DEMO previously interrupted bytes', { flag: 'wx' });
      await assert.rejects(() => files.upload(delivery.id, { ...upload, requestId: id }, principal), ConflictException);
      const failed = (await store.detail(delivery.id)).files.find((file) => file.id === id);
      assert.equal(failed?.status, 'failed');
      assert.equal((await readFile(path.join(files.directory, pendingName))).toString('utf8'), 'DEMO previously interrupted bytes');
      await assert.rejects(() => files.download(delivery.id, id), NotFoundException);
      await assert.rejects(() => files.upload(delivery.id, { ...upload, requestId: id }, principal), ConflictException);
      const receipts = await rows(database.source.manager, z.object({ count: z.string() }), 'SELECT count(*)::text AS count FROM command_receipt WHERE request_id=$1', [id]);
      assert.equal(receipts[0]?.count, '0');
    });

    await context.test('document versions keep exact line identity, current listings and immutable private history', async () => {
      const originalItem=source.items[0];
      assert.ok(originalItem);
      const documentDelivery=createDelivery({...structuredClone(source),pickingId:3,pickingName:'FILES/DEMO/0003',
        items:[{...originalItem,saleOrderId:1},{...originalItem,sourceLineId:20,saleOrderId:2}],
        salesOrders:[{id:1,name:'FILES/SO/0001'},{id:2,name:'FILES/SO/0002'}]},randomUUID());
      await database.source.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)',
        [documentDelivery.id,schema,3,documentDelivery.version,JSON.stringify(documentDelivery)]);
      const firstId=randomUUID();
      const secondId=randomUUID();
      const otherLineId=randomUUID();
      for(const id of [firstId,secondId,otherLineId]) ownedPhysicalFiles.add(id);
      const first={...upload,requestId:firstId,documentPurpose:'instruction'};
      await files.upload(documentDelivery.id,first,principal);
      const firstDownload=await files.download(documentDelivery.id,firstId);
      assert.equal(firstDownload.file.documentVersion,1);
      assert.equal(firstDownload.file.documentSource,'local_upload');
      assert.deepEqual(firstDownload.file.uploadedBy,{id:principal.id,name:principal.name});
      const snapshot=JSON.stringify(firstDownload.file);
      const replacement={...first,requestId:secondId,base64:Buffer.from('DEMO updated assembly instruction').toString('base64'),supersedesFileId:firstId};
      await assert.rejects(()=>files.upload(documentDelivery.id,{...replacement,itemId:20},principal),BadRequestException);
      await assert.rejects(()=>files.upload(delivery.id,replacement,principal),BadRequestException);
      await files.upload(documentDelivery.id,replacement,principal);
      await files.upload(documentDelivery.id,replacement,principal);
      await files.upload(documentDelivery.id,{...first,requestId:otherLineId,itemId:20,documentPurpose:'drawing'},principal);
      const current=await files.crewDocuments(documentDelivery.id,randomUUID(),[10,20]);
      assert.deepEqual(new Set(current.map(({id})=>id)),new Set([secondId,otherLineId]));
      assert.equal(current.find(({id})=>id===secondId)?.documentVersion,2);
      assert.equal(current.find(({id})=>id===secondId)?.supersedesFileId,firstId);
      assert.deepEqual((await files.crewDocuments(documentDelivery.id,randomUUID(),[10])).map(({id})=>id),[secondId]);
      assert.equal((await files.crewDocuments(documentDelivery.id,randomUUID(),[20],firstId)).length,0);
      assert.equal((await files.crewDocuments(documentDelivery.id,randomUUID(),[10],firstId))[0]?.id,firstId);
      assert.equal(JSON.stringify((await files.download(documentDelivery.id,firstId)).file),snapshot);
      assert.deepEqual((await files.download(documentDelivery.id,firstId)).bytes,firstDownload.bytes);
      await assert.rejects(()=>files.upload(documentDelivery.id,{...replacement,requestId:randomUUID()},principal),ConflictException);

      const legacyId=randomUUID();
      await database.source.query(`INSERT INTO file_record(id,delivery_id,actor_id,name,mime,size,kind,item_id,status)
        VALUES($1,$2,$3,'Legacy instruction.txt','text/plain',1,'document',10,'ready')`,[legacyId,documentDelivery.id,principal.id]);
      const legacy=(await store.detail(documentDelivery.id)).files.find(({id})=>id===legacyId);
      assert.equal(legacy?.documentVersion,null);
      assert.equal(legacy?.documentPurpose,null);
      assert.equal(legacy?.documentSource,null);
      const legacyReplacementId=randomUUID();
      ownedPhysicalFiles.add(legacyReplacementId);
      await files.upload(documentDelivery.id,{...first,requestId:legacyReplacementId,supersedesFileId:legacyId},principal);
      assert.equal((await files.download(documentDelivery.id,legacyReplacementId)).file.documentVersion,1);
      assert.equal((await store.detail(documentDelivery.id)).files.find(({id})=>id===legacyId)?.documentVersion,null);
    });

    await context.test('file completion rechecks actual closure after pending metadata and bytes were written', async () => {
      const person = { kind: 'crew' as const, id: randomUUID(), name: 'DEMO responsible representative' };
      const task = instantiateTask({ id: randomUUID(), version: 1, title: 'DEMO check goods', severity: 'low', order: 0, checklist: ['Check goods'], enabled: true });
      const appointment: Appointment = {
        id: randomUUID(), startsAt: '2026-11-03T08:00:00Z', endsAt: '2026-11-03T09:00:00Z', status: 'booked', cancellationReason: null, returnRequestId: null,
        assignments: [{ id: randomUUID(), crewId: randomUUID(), crewName: 'DEMO crew', people: [{ id: person.id, name: person.name, external: false }], tasks: [task] }], results: [],
      };
      const current = await store.get(delivery.id);
      const worked = await store.mutate(delivery.id, current.version, principal, 'test.fixture_work', (aggregate) => {
        appointment.workScope = planVisitWork(aggregate, [{ sourceLineId: 10, deliveryMilli: 1000, installationMilli: 0, collectionMilli: 0 }], principal, '2026-11-03T07:00:00Z');
        aggregate.appointments.push(appointment);
        const confirmed = confirmCustomerVisit(aggregate, appointment.id, principal, '2026-11-03T07:00:00Z');
        return recordExecution(startVisit(confirmed, appointment.id, person), {
          id: randomUUID(), appointmentId: appointment.id, supersedesResultId: null, correctionReason: null,
          actualStart: '2026-11-03T08:00:00Z', actualEnd: '2026-11-03T09:00:00Z', summary: 'DEMO completed work', responsiblePersonId: person.id,
          quantities: [{ sourceLineId: 10, deliveredMilli: 1000 }], completedChecklistIds: task.checklist.map((item) => item.id), evidence: [],
          customerSignature: { status: 'signed', signerName: 'DEMO customer', text: 'DEMO customer approval', at: '2026-11-03T09:00:00Z' },
          crewSignature: { status: 'signed', signerName: person.name, text: 'DEMO crew approval', at: '2026-11-03T09:00:00Z' },
        }, person, '2026-11-03T10:00:00Z');
      });
      const barrierStore = new FinalizationBarrierStore(database, delivery.id);
      const delayedFiles = new Files(barrierStore);
      const requestId = randomUUID();
      ownedPhysicalFiles.add(requestId);
      const pendingUpload = delayedFiles.upload(delivery.id, { ...upload, requestId }, principal);
      // Observe rejection immediately to avoid an unhandled promise while the independent close transaction runs.
      const outcome = pendingUpload.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
      try {
        await barrierStore.entered.promise;
        assert.equal((await store.detail(delivery.id)).files.find((file) => file.id === requestId)?.status, 'pending');
        const closed = await store.mutate(delivery.id, worked.version, principal, 'delivery.completed', (aggregate) =>
          completeDelivery(aggregate, principal, randomUUID(), '2026-11-03T11:00:00Z'));
        const closedSnapshot = JSON.stringify(closed);
        barrierStore.continueRead.release();
        const result = await outcome;
        assert.equal(result.ok, false);
        if (result.ok) throw new Error('Closed-delivery upload unexpectedly succeeded');
        assert.ok(result.error instanceof ConflictException);
        assert.equal(JSON.stringify(await store.get(delivery.id)), closedSnapshot);
        assert.equal((await store.detail(delivery.id)).files.find((file) => file.id === requestId)?.status, 'failed');
        await assert.rejects(() => files.download(delivery.id, requestId), NotFoundException);
        assert.equal((await readFile(path.join(files.directory, requestId))).toString('utf8'), 'DEMO synthetic operator document');
      } finally {
        barrierStore.continueRead.release();
        await outcome;
      }
    });

    await context.test('closure verifies effective evidence bytes and a valid correction supersedes unavailable old evidence', async () => {
      const operations = new Operations(store, files, new Participants(store), new Skills(store), new Vehicles(store,new Participants(store)), new DeliveryPoints(store));
      const gateway = new Execution(store, files);
      const representative = { id: randomUUID(), name: 'DEMO evidence representative', external: false };
      const task = instantiateTask({ id: randomUUID(), version: 1, title: 'DEMO inspect evidence', severity: 'medium', order: 0, checklist: ['Verify item'], enabled: true });
      const appointment: Appointment = {
        id: randomUUID(), startsAt: '2026-11-03T08:00:00Z', endsAt: '2026-11-03T09:00:00Z', status: 'booked', cancellationReason: null, returnRequestId: null,
        assignments: [{ id: randomUUID(), crewId: randomUUID(), crewName: 'DEMO evidence crew', people: [representative], tasks: [task] }], results: [],
      };
      const aggregate = createDelivery({ ...structuredClone(source), pickingId: 2, pickingName: 'FILES/DEMO/0002' }, randomUUID());
      appointment.workScope = planVisitWork(aggregate, [{ sourceLineId: 10, deliveryMilli: 1000, installationMilli: 0, collectionMilli: 0 }], principal, '2026-11-03T07:00:00Z');
      aggregate.appointments.push(appointment);
      await database.source.transaction(async (manager) => {
        await manager.query('INSERT INTO delivery(id,source_instance,source_id,version,data) VALUES($1,$2,$3,$4,$5::jsonb)', [aggregate.id, schema, 2, aggregate.version, JSON.stringify(aggregate)]);
        await manager.query('INSERT INTO appointment(id,delivery_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,$5)', [appointment.id, aggregate.id, appointment.startsAt, appointment.endsAt, appointment.status]);
      });
      const authorized = await gateway.authorizeLocalScenario(aggregate.id, appointment.id, principal);
      const originalFileId = await gateway.attachSyntheticEvidence(authorized, 10);
      ownedPhysicalFiles.add(originalFileId);
      const originalBytes = await readFile(path.join(files.directory, originalFileId));
      const result: ExecutionInput = {
        id: randomUUID(), appointmentId: appointment.id, supersedesResultId: null, correctionReason: null,
        actualStart: '2026-11-03T08:00:00Z', actualEnd: '2026-11-03T09:00:00Z', summary: 'DEMO signed result with private evidence', responsiblePersonId: representative.id,
        quantities: [{ sourceLineId: 10, deliveredMilli: 1000 }], completedChecklistIds: task.checklist.map((item) => item.id),
        evidence: [{ id: originalFileId, type: 'assembly', itemIds: [10] }],
        customerSignature: { status: 'signed', signerName: 'DEMO customer', text: 'DEMO customer approval', at: '2026-11-03T09:00:00Z' },
        crewSignature: { status: 'signed', signerName: representative.name, text: 'DEMO crew approval', at: '2026-11-03T09:00:00Z' },
      };
      const confirmed = await operations.confirmCustomer(aggregate.id, appointment.id, { version: aggregate.version }, principal);
      let detail = await gateway.receive(authorized, confirmed.delivery.version, result);
      assert.deepEqual(closureBlockers(detail.delivery), []);
      const signedOriginal = JSON.stringify(detail.delivery.appointments[0]?.results[0]);
      const beforeFailure = JSON.stringify(detail.delivery);
      await unlink(path.join(files.directory, originalFileId));
      await assert.rejects(() => operations.complete(aggregate.id, { version: detail.delivery.version }, principal), ConflictException);
      assert.equal(JSON.stringify(await store.get(aggregate.id)), beforeFailure);
      // Same byte count defeats a metadata-size-only check; the decoder must reject these bytes.
      const forgedPng = Buffer.alloc(originalBytes.length);
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(forgedPng);
      forgedPng.writeUInt32BE(1, 16);
      forgedPng.writeUInt32BE(1, 20);
      Buffer.from('IEND').copy(forgedPng, forgedPng.length - 8);
      await writeFile(path.join(files.directory, originalFileId), forgedPng, { flag: 'wx' });
      await assert.rejects(() => operations.complete(aggregate.id, { version: detail.delivery.version }, principal), ConflictException);
      assert.equal(JSON.stringify(await store.get(aggregate.id)), beforeFailure);
      await writeFile(path.join(files.directory, originalFileId), originalBytes);
      detail = await operations.complete(aggregate.id, { version: detail.delivery.version }, principal);
      assert.equal(detail.progress, 'completed');
      detail = await operations.reopen(aggregate.id, { version: detail.delivery.version, reason: 'DEMO replace unavailable evidence with an explicit signed correction' }, principal);
      const replacementFileId = await gateway.attachSyntheticEvidence(authorized, 10);
      ownedPhysicalFiles.add(replacementFileId);
      await unlink(path.join(files.directory, originalFileId));
      ownedPhysicalFiles.delete(originalFileId);
      detail = await gateway.receive(authorized, detail.delivery.version, {
        ...result, id: randomUUID(), supersedesResultId: result.id, correctionReason: 'DEMO replacement private evidence supplied as a new signed version',
        evidence: [{ id: replacementFileId, type: 'assembly', itemIds: [10] }],
      });
      assert.equal(JSON.stringify(detail.delivery.appointments[0]?.results[0]), signedOriginal);
      assert.equal(detail.delivery.appointments[0]?.results.length, 2);
      detail = await operations.complete(aggregate.id, { version: detail.delivery.version }, principal);
      assert.equal(detail.progress, 'completed');
      assert.equal(detail.delivery.completions.length, 2);
      assert.equal(detail.delivery.completions[0]?.resultIds[0], result.id);
      assert.notEqual(detail.delivery.completions[1]?.resultIds[0], result.id);
    });
    await identity.logout({ headers: { cookie: 'backoffice_session=' + login.token } });
  } finally {
    await database.onModuleDestroy();
    for (const name of ownedPhysicalFiles) {
      try { await unlink(path.resolve('.local/files-test', name)); }
      catch (error: unknown) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; }
    }
    if (admin.isInitialized) {
      if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.destroy();
    }
  }
});
