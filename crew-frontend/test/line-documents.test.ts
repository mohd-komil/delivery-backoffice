import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import test from 'node:test';
import type { VisitDetail } from '../src/shared/api/contracts';
import { readItemChecks } from '../src/_pages/visit-detail/model/item-check';
import { DocumentLinks } from '../src/_pages/visit-detail/ui/document-links';
import { FinishPhotos } from '../src/_pages/visit-detail/ui/finish-photos';
import { IssueForm } from '../src/_pages/visit-detail/ui/issue-form';
import { FinishItems } from '../src/_pages/visit-detail/ui/finish-items';
import { renderLocalized } from './render-localized';

const chair={name:'Identical chair',quantity:1,remainingMilli:1000,uom:'unit',configuration:null,notes:null};
const items:VisitDetail['items']=[{...chair,sourceLineId:31,orderName:'ORDER A'},{...chair,sourceLineId:32,orderName:'ORDER B'}];

void test('standalone issue product options and Finish condition names identify both same-SKU order lines',()=>{
  const visit:VisitDetail={id:randomUUID(),pickingName:'DEMO/TEST',startsAt:'2026-11-11T09:00:00Z',endsAt:'2026-11-11T10:00:00Z',
    status:'in_progress',confirmationStatus:'customer_confirmed',destination:{address:null,city:null,country:null},crews:[],vehicles:[],
    version:1,responsibleParticipant:{id:randomUUID(),name:'Matteo'},canFinish:true,canStart:false,scopeReviewReason:null,workScope:null,
    actualStartedAt:'2026-11-11T09:00:00Z',unfinishedChecklistCount:0,customer:{name:'Demo',contact:null,phones:[]},
    instructions:{floor:null,elevator:'unknown',access:null,parking:null,restrictions:null,notes:null},items,tasks:[],
  };
  for(const locale of ['en','it','ru','uz'] as const){
    const issues=renderLocalized(createElement(IssueForm,{visit,actions:{busy:null,run:async()=>false}}),locale);
    const finish=renderLocalized(createElement(FinishItems,{items,error:null,clearError:()=>undefined}),locale);
    for(const [line,order] of [[31,'ORDER A'],[32,'ORDER B']] as const){
      assert.match(issues,new RegExp(`<option value="${line}">Identical chair · ${order} · [^<]*${line}[^<]*</option>`));
      assert.match(finish,new RegExp(`<button[^>]*role="combobox"[^>]*aria-label="Identical chair · ${order} · [^"]*${line}[^"]*"`));
      assert.match(finish,new RegExp(`<select[^>]*name="check-status-${line}"[^>]*data-combobox-native`));
    }
    assert.doesNotMatch(issues,/MISSING_MESSAGE|undefined/);
  }
});

void test('line photo controls exclude the other same-SKU order photos and preselect the exact target',()=>{
  const html=renderLocalized(createElement(FinishPhotos,{items,fixedLineId:31,photos:[
    // Next's Image is checked in the browser; Node's test loader exposes its CJS namespace.
    {file:new File(['b'],'order-b.png',{type:'image/png'}),previewUrl:'blob:order-b',sourceLineId:32},
  ],requiredError:false,onChange:()=>undefined,previews:{create:()=>'',remove:()=>undefined}}));
  assert.match(html,/New photos are linked to line 31/);
  assert.match(html,/No photos selected/);
  assert.doesNotMatch(html,/order-b.png|Attach new photos to/);
});

void test('same SKU keeps independent problem categories and existing Issue links, dropping stale fields for OK',()=>{
  const fields=new FormData();
  const issueId=randomUUID();
  fields.set('check-status-31','problem');fields.set('check-problemType-31','damage');fields.set('check-linkedIssueId-31',issueId);
  fields.set('check-status-32','ok');fields.set('check-problemType-32','damage');fields.set('check-linkedIssueId-32',issueId);
  assert.deepEqual(readItemChecks(items,fields),{ok:true,itemChecks:[
    {sourceLineId:31,status:'problem',note:null,problemType:'damage',linkedIssueId:issueId},
    {sourceLineId:32,status:'ok',note:null},
  ]});
});

void test('document links show recorded version/source and preserve explicit legacy unknown values in all locales',()=>{
  const visitId=randomUUID();
  const currentId=randomUUID();
  const documents:NonNullable<VisitDetail['documents']>=[{
    id:currentId,name:'Assembly manual.pdf',mime:'application/pdf',itemId:31,createdAt:'2026-11-11T10:00:00Z',
    documentPurpose:'instruction',documentVersion:2,documentSource:'local_upload',supersedesFileId:randomUUID(),uploadedBy:{id:randomUUID(),name:'Francesca'},
  },{id:randomUUID(),name:'Legacy.pdf',mime:'application/pdf',itemId:32,createdAt:'2026-11-10T10:00:00Z',
    documentPurpose:null,documentVersion:null,documentSource:null,supersedesFileId:null,uploadedBy:null}];
  for(const locale of ['en','it','ru','uz'] as const){
    const html=renderLocalized(createElement(DocumentLinks,{visitId,documents}),locale);
    assert.match(html,new RegExp(`/api/crew/visits/${visitId}/documents/${currentId}`));
    assert.match(html,/Assembly manual.pdf/);assert.match(html,/Francesca/);
    assert.doesNotMatch(html,/MISSING_MESSAGE|undefined/);
    if(locale==='en'){assert.match(html,/Version 2/);assert.match(html,/Version not recorded/);assert.match(html,/Source not recorded/);}
  }
});
