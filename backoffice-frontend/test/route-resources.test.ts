import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { act, createElement } from 'react';
import test from 'node:test';
import { participantSchema } from '../src/lib/contracts';
import type { RoutePlanning, RouteWindow } from '../src/lib/route-drafts';
import { ApiFixture, domHarness } from './refresh-fixtures';

void test('removing a selected disabled participant also clears its driver role and only its working intervals',async()=>{
  const first=participantSchema.parse({id:randomUUID(),version:1,name:'Marco Russo',firstName:'Marco',lastName:'Russo',preferredName:null,
    phoneNumber:null,address:null,login:null,external:false,enabled:false,hasPassword:false,skillIds:[]});
  const second={...first,id:randomUUID(),name:'Luca Marino',enabled:true};
  const interval={startsAt:'2026-11-11T08:00:00Z',endsAt:'2026-11-11T17:00:00Z'};
  let planning:RoutePlanning={participantIds:[first.id,second.id],participantAvailability:[
    {participantId:first.id,workingIntervals:[interval],unavailableIntervals:[]},
    {participantId:second.id,workingIntervals:[interval],unavailableIntervals:[]},
  ],vehicleAvailability:null,driver:{kind:'participant',participantId:first.id},transferBufferMinutes:0};
  const page=await domHarness(new ApiFixture());
  try{
    const {RouteResourceFields}=await import('../src/components/route-planning-controls');
    const render=()=>page.render(createElement(RouteResourceFields,{value:planning,participants:[first,second],onChange:(next:RoutePlanning)=>{planning=next;}}));
    await render();
    const firstLabel=Array.from(page.container.querySelectorAll('label')).find((label)=>label.textContent==='Marco Russo');assert.ok(firstLabel);
    const checkbox=firstLabel.querySelector('input');assert.ok(checkbox);
    assert.equal(checkbox.checked,true);assert.equal(checkbox.disabled,false);
    await act(async()=>{checkbox.click();});
    assert.deepEqual(planning.participantIds,[second.id]);
    assert.deepEqual(planning.driver,{kind:'unknown'});
    assert.deepEqual(planning.participantAvailability,[{participantId:second.id,workingIntervals:[interval],unavailableIntervals:[]}]);
    await render();
    assert.equal(Array.from(page.container.querySelectorAll('label')).some((label)=>label.textContent==='Marco Russo'),false,'A disabled person cannot be selected again.');
    const driver=page.container.querySelector('select');assert.ok(driver);
    assert.equal(driver.value,'unknown');assert.equal(driver.selectedOptions[0]?.textContent,'Not specified');
  }finally{await page.close();}
});

void test('unknown customer windows stay explicit; changing arrival versus completion preserves the chosen interval',async()=>{
  const page=await domHarness(new ApiFixture());
  const interval={startsAt:'2026-11-11T09:00:00Z',endsAt:'2026-11-11T10:00:00Z'};
  let value:RouteWindow|undefined;
  try{
    const {RouteWindowFields}=await import('../src/components/route-planning-controls');
    const render=()=>page.render(createElement(RouteWindowFields,{value,initialWindow:interval,onChange:(next:RouteWindow)=>{value=next;}}));
    const choose=async(kind:string)=>{
      const select=page.container.querySelector('select');assert.ok(select);
      await act(async()=>{select.value=kind;select.dispatchEvent(new Event('change',{bubbles:true}));});
      await render();
    };
    await render();
    assert.equal(page.container.querySelector('select')?.value,'unknown');
    assert.equal(page.container.querySelector('option:checked')?.textContent,'Not specified');
    assert.equal(page.container.querySelector('input[type="datetime-local"]'),null);
    await choose('unrestricted');assert.deepEqual(value,{kind:'unrestricted'});
    await choose('arrival');assert.deepEqual(value,{...interval,kind:'arrival'});
    const dates=Array.from(page.container.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]'));
    assert.deepEqual(dates.map((input)=>input.value),['2026-11-11T10:00','2026-11-11T11:00']);
    await choose('work_end');assert.deepEqual(value,{...interval,kind:'work_end'});
    assert.equal(page.container.querySelector('input[type="datetime-local"]'),dates[0],'Changing window semantics must not remount and discard the time draft.');
    await choose('unknown');assert.deepEqual(value,{kind:'unknown'});
    assert.equal(page.container.querySelector('input[type="datetime-local"]'),null);
  }finally{await page.close();}
});

void test('resource form does not silently invent a driver, shift, vehicle availability or transfer buffer',async()=>{
  const page=await domHarness(new ApiFixture());
  const changes:RoutePlanning[]=[];
  try{
    const {RouteResourceFields,emptyRoutePlanning}=await import('../src/components/route-planning-controls');
    await page.render(createElement(RouteResourceFields,{value:emptyRoutePlanning,participants:[],onChange:(next:RoutePlanning)=>{changes.push(next);}}));
    assert.equal(page.container.querySelector('select')?.value,'unknown');
    assert.equal(page.container.querySelector('input[type="datetime-local"]'),null);
    const buffer=page.container.querySelector<HTMLInputElement>('input[type="number"]');assert.ok(buffer);assert.equal(buffer.value,'');
    const vehicle=page.container.querySelector<HTMLInputElement>('input[type="checkbox"]');assert.ok(vehicle);assert.equal(vehicle.checked,false);
    assert.match(page.container.textContent??'',/Empty means the transfer allowance is unknown/);
    assert.equal(changes.length,0,'Displaying the form must not create fabricated availability.');
    await act(async()=>{vehicle.click();});
    assert.deepEqual(changes[0]?.vehicleAvailability,{startsAt:'',endsAt:''},'Enabling availability requests explicit times, not invented default hours.');
  }finally{await page.close();}
});
