import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { act, createElement } from 'react';
import test from 'node:test';
import { appointmentSchema, fileSchema } from '../src/lib/contracts';
import { DeliveryFiles, DeliveryResultDocuments } from '../src/components/delivery-files';
import { ApiFixture, domHarness } from './refresh-fixtures';

void test('documents separate same-SKU order lines from general files and replacement keeps its scope',async()=>{
  const api=new ApiFixture();
  const source=api.detail.delivery.source;
  const item=source.items[0];assert.ok(item);
  source.salesOrders=[{id:1,name:'ORDER A'},{id:2,name:'ORDER B'}];
  source.items=[{...item,saleOrderId:1},{...item,sourceLineId:20,saleOrderId:2}];
  const firstId=randomUUID();const currentId=randomUUID();
  const base={deliveryId:api.detail.delivery.id,name:'Assembly.txt',mime:'text/plain',size:22,kind:'document',appointmentId:null,
    itemId:10,issueId:null,status:'ready',createdAt:'2026-11-11T09:00:00Z',documentPurpose:'instruction',documentVersion:1,
    documentSource:'local_upload',supersedesFileId:null,uploadedBy:null};
  api.detail.files=[fileSchema.parse({...base,id:firstId}),fileSchema.parse({...base,id:currentId,documentVersion:2,supersedesFileId:firstId}),
    fileSchema.parse({...base,id:randomUUID(),name:'Drawing.txt',itemId:20,documentPurpose:'drawing'}),
    fileSchema.parse({...base,id:randomUUID(),name:'General.txt',itemId:null,documentPurpose:null,documentVersion:null,documentSource:null})];
  const page=await domHarness(api);
  try{
    await page.render(createElement(DeliveryFiles,{detail:api.detail,command:async()=>1}));
    const document=page.dom.window.document;
    const text=document.body.textContent??'';
    assert.match(text,/General delivery documents/);assert.match(text,/ORDER A/);assert.match(text,/ORDER B/);
    assert.match(text,/Version 2/);assert.match(text,/Previous version/);assert.match(text,/Not recorded/);
    const choose=document.querySelector('select');assert.ok(choose);
    await act(async()=>{choose.value=currentId;choose.dispatchEvent(new Event('change',{bubbles:true}));});
    for(const name of ['kind','appointmentId','itemId','issueId']){
      const field=document.querySelector(`select[name="${name}"]`);assert.ok(field instanceof HTMLSelectElement);assert.equal(field.disabled,true);
    }
    assert.equal(document.querySelector<HTMLSelectElement>('select[name="itemId"]')?.value,'10');
  }finally{await page.close();}
});

void test('report document readout links recorded version and keeps legacy report uncertainty',async()=>{
  const api=new ApiFixture();const delivery=api.detail.delivery;const visitId=randomUUID();const oldFileId=randomUUID();
  const at='2026-11-11T10:00:00Z';
  const visit=appointmentSchema.parse({id:visitId,startsAt:at,endsAt:at,status:'completed',cancellationReason:null,returnRequestId:null,assignments:[],results:[{
    id:randomUUID(),appointmentId:visitId,receivedAt:at,actualStart:at,actualEnd:at,summary:'DEMO',supersedesResultId:null,correctionReason:null,
    actor:{kind:'crew',id:randomUUID(),name:'Matteo'},responsiblePersonId:randomUUID(),quantities:[],evidence:[],customerSignature:null,crewSignature:null,
    sourceSnapshot:delivery.source,instructionsSnapshot:delivery.instructions,assignmentsSnapshot:[],documentSnapshot:[{
      id:oldFileId,name:'Recorded version.txt',mime:'text/plain',itemId:10,createdAt:at,documentPurpose:'instruction',documentVersion:1,
      documentSource:'local_upload',supersedesFileId:null,uploadedBy:null,
    }],
  }]});
  const result=visit.results[0];assert.ok(result);
  const page=await domHarness(api);
  try{
    await page.render(createElement(DeliveryResultDocuments,{result,deliveryId:delivery.id}));
    assert.match(page.dom.window.document.querySelector('a')?.href??'',new RegExp(`${oldFileId}$`));
    assert.match(page.dom.window.document.body.textContent??'',/Version 1/);
    const legacy={...result};delete legacy.documentSnapshot;
    await page.render(createElement(DeliveryResultDocuments,{result:legacy,deliveryId:delivery.id}));
    assert.match(page.dom.window.document.body.textContent??'',/Document versions were not recorded/);
    assert.equal(page.dom.window.document.querySelector('a'),null);
  }finally{await page.close();}
});
