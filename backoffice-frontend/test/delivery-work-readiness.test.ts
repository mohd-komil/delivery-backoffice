import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import test from 'node:test';
import type { Delivery } from '../src/lib/contracts';
import { ApiFixture, button, click, domHarness, editInput, hasToast, user } from './refresh-fixtures';

function heldDelivery():Delivery {
  const delivery=new ApiFixture().detail.delivery;
  const item=delivery.source.items[0];assert.ok(item);
  delivery.source.salesOrders=[{id:1,name:'ORDER A'},{id:2,name:'ORDER B'}];
  delivery.source.items=[{...item,saleOrderId:1},{...item,sourceLineId:20,saleOrderId:2}];
  const by={id:user.id,name:'Francesca'};
  const common={reason:'damage' as const,createdAt:'2026-11-11T08:00:00Z',createdBy:{id:randomUUID(),name:'Matteo'}};
  delivery.workHolds=[
    {...common,id:randomUUID(),sourceLineId:10,release:{at:'2026-11-11T09:00:00Z',by,note:'An earlier replacement was checked.'}},
    {...common,id:randomUUID(),sourceLineId:10,issueId:randomUUID()},
    {...common,id:randomUUID(),sourceLineId:20,release:{at:'2026-11-11T09:00:00Z',by,note:'Ready after inspection. <b>Recorded text</b>'}},
  ];
  return delivery;
}

void test('readiness preserves same-SKU order identity and requires an explicit dispatcher note for the held line',async()=>{
  const delivery=heldDelivery();
  const released:Array<{sourceLineId:number;note:string}>=[];
  const page=await domHarness(new ApiFixture());
  try{
    const {DeliveryWorkReadiness}=await import('../src/components/delivery-work-readiness');
    await page.render(createElement(DeliveryWorkReadiness,{delivery,release:async(sourceLineId:number,note:string)=>{released.push({sourceLineId,note});return delivery.version+1;}}));
    const [first,second]=page.container.querySelectorAll('article');assert.ok(first&&second);
    assert.match(first.textContent??'',/ORDER A/);assert.match(first.textContent??'',/Blocked · damaged product/);
    assert.match(second.textContent??'',/ORDER B/);assert.match(second.textContent??'',/Ready for repeat work/);
    assert.equal(second.querySelector('form'),null,'A released line has no new release action.');
    assert.equal(second.querySelector('b'),null,'Dispatcher notes are text, never markup.');
    const submit=button(first,'Ready for repeat visit');
    await click(submit);
    assert.deepEqual(released,[],'An empty required explanation must never be submitted.');
    const note=first.querySelector('textarea');assert.ok(note);
    await editInput(note,'  Replacement arrived and its finish was checked.  ');
    await click(submit);
    assert.deepEqual(released,[{sourceLineId:10,note:'Replacement arrived and its finish was checked.'}]);
    assert.ok(hasToast(page.dom.window.document,'Readiness recorded'));
    assert.match(page.container.textContent??'',/Resolving an Issue does not release it/);
  }finally{await page.close();}
});

void test('readiness refresh retains the note but refuses an obsolete delivery version; history is read-only',async()=>{
  const delivery=heldDelivery();
  let commands=0;
  const release=async()=>{commands+=1;return 2;};
  const page=await domHarness(new ApiFixture());
  try{
    const {DeliveryWorkReadiness}=await import('../src/components/delivery-work-readiness');
    await page.render(createElement(DeliveryWorkReadiness,{delivery,release}));
    const note=page.container.querySelector('textarea');assert.ok(note);
    await editInput(note,'Inspected by warehouse');
    await page.render(createElement(DeliveryWorkReadiness,{delivery:{...delivery,version:delivery.version+1},release}));
    assert.equal(page.container.querySelector('textarea'),note);
    assert.equal(note.value,'Inspected by warehouse');
    await click(button(page.container,'Ready for repeat visit'));
    assert.equal(commands,0);
    await page.render(createElement(DeliveryWorkReadiness,{delivery}));
    assert.equal(page.container.querySelector('form'),null,'History has no mutation callback.');
    await page.render(createElement(DeliveryWorkReadiness,{delivery:{...delivery,completedAt:'2026-11-11T10:00:00Z'},release}));
    assert.equal(page.container.querySelector('form'),null,'Closed deliveries cannot release readiness holds.');
    assert.equal(commands,0);
  }finally{await page.close();}
});
