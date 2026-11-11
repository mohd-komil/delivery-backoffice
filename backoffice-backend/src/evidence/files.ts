import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import type { EntityManager } from 'typeorm';
import { DeliveryStore } from '../operations/store';
import { FileSchema } from '../operations/contracts';
import { rows } from '../database/database';
import { IdSchema, type OperatorActor } from '../domain/model';
import { FILE_COLUMNS } from './file-record';
export const FilePayloadSchema=z.object({name:z.string().min(1).max(120),base64:z.string().max(7_000_000)}).strict();
export const UploadSchema=FilePayloadSchema.extend({requestId:IdSchema.optional(),kind:z.enum(['document','photo']),appointmentId:IdSchema.nullable(),itemId:z.number().int().positive().nullable(),issueId:IdSchema.nullable(),
  documentPurpose:z.enum(['general','instruction','drawing']).optional(),supersedesFileId:IdSchema.optional()});
export const CrewDocumentSchema=FileSchema.pick({id:true,name:true,mime:true,size:true,itemId:true,createdAt:true,documentPurpose:true,
  documentVersion:true,documentSource:true,supersedesFileId:true,uploadedBy:true});
export const MAX_FILE_BYTES=5*1024*1024;
export function inspectFile(name:string,base64:string) {
  if(!/^[\p{L}\p{N} _().-]+$/u.test(name)||name.includes('..')||name.startsWith('.')) throw new BadRequestException('Unsafe filename');
  if(base64.length>Math.ceil(MAX_FILE_BYTES/3)*4) throw new BadRequestException('File exceeds 5 MiB');
  // Canonical round-trip avoids a recursive regex on megabytes of attacker-controlled text.
  if(base64.length%4!==0||/[^A-Za-z0-9+/=]/.test(base64)) throw new BadRequestException('Invalid base64');
  const bytes=Buffer.from(base64,'base64');
  if(bytes.toString('base64')!==base64) throw new BadRequestException('Invalid base64');
  if(bytes.length===0||bytes.length>MAX_FILE_BYTES) throw new BadRequestException('File must be between 1 byte and 5 MiB');
  const extension=path.extname(name).toLowerCase();
  if(extension==='.png'&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.subarray(-8,-4).toString('ascii')==='IEND') {
    if(bytes.length<45||bytes.readUInt32BE(16)>10000||bytes.readUInt32BE(20)>10000) throw new BadRequestException('Invalid image dimensions');
    return {bytes,mime:'image/png'};
  }
  if(['.jpg','.jpeg'].includes(extension)&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&bytes[bytes.length-2]===255&&bytes[bytes.length-1]===217) return {bytes,mime:'image/jpeg'};
  if(extension==='.pdf'&&bytes.subarray(0,5).toString('ascii')==='%PDF-'&&bytes.subarray(-1024).toString('ascii').includes('%%EOF')) return {bytes,mime:'application/pdf'};
  if(extension==='.txt'){
    let text:string;
    try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new BadRequestException('Invalid UTF-8 text document');}
    if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new BadRequestException('Invalid text document');
    return {bytes,mime:'text/plain'};
  }
  throw new BadRequestException('Allowed files: PDF, UTF-8 TXT, PNG or JPEG with matching content');
}
export async function validateFileContent(file:{bytes:Buffer;mime:string}) {
  try{
    if(file.mime.startsWith('image/')) {
      // Decode every pixel with a maintained decoder; magic bytes alone do not prove an image is valid.
      await sharp(file.bytes,{limitInputPixels:20_000_000,failOn:'warning'}).raw().toBuffer();
    }else if(file.mime==='application/pdf'){
      const document=await PDFDocument.load(file.bytes,{ignoreEncryption:false,throwOnInvalidObject:true});
      if(document.getPageCount()<1||document.getPageCount()>500) throw new Error('Invalid page count');
    }
  }catch{throw new BadRequestException('File content is malformed, encrypted or exceeds supported limits');}
}

export async function inspectCrewPhoto(photo: z.infer<typeof FilePayloadSchema>) {
  const file = inspectFile(photo.name, photo.base64);
  if (file.mime !== 'image/jpeg' && file.mime !== 'image/png') throw new BadRequestException('A photo requires PNG or JPEG content');
  await validateFileContent(file);
  return { ...file, name: photo.name };
}
type CrewPhoto = Awaited<ReturnType<typeof inspectCrewPhoto>>;

@Injectable()
export class Files {
  readonly directory=path.resolve('.local',process.env['BACKOFFICE_TEST']==='1'?'files-test':'files');
  constructor(@Inject(DeliveryStore) private readonly store:DeliveryStore) {}

  async writeCrewPhoto(id: string, photo: CrewPhoto) {
    await mkdir(this.directory, { recursive: true });
    const filename = path.join(this.directory, IdSchema.parse(id));
    const handle = await open(filename, 'wx', 0o600);
    try {
      try { await handle.writeFile(photo.bytes); } finally { await handle.close(); }
    } catch (error: unknown) {
      await rm(filename, { force: true }).catch(logCrewPhotoCleanupFailure);
      throw error;
    }
  }

  async registerCrewPhoto(manager: EntityManager, photo: CrewPhoto, link: {
    id: string; deliveryId: string; actorId: string; appointmentId: string; issueId: string | null; itemId: number | null;
  }) {
    await manager.query(`INSERT INTO file_record(id,delivery_id,actor_id,name,mime,size,kind,appointment_id,item_id,issue_id,status)
      VALUES($1,$2,$3,$4,$5,$6,'evidence',$7,$8,$9,'ready')`,
    [link.id, link.deliveryId, link.actorId, photo.name, photo.mime, photo.bytes.length, link.appointmentId, link.itemId, link.issueId]);
  }

  async discardUnregisteredCrewPhoto(id: string) {
    try {
      const fileId = IdSchema.parse(id);
      const found = await rows(this.store.db.source.manager, z.object({ id: IdSchema }), 'SELECT id FROM file_record WHERE id = $1', [fileId]);
      // Preserve private bytes if a commit succeeded before the connection reported an error.
      if (!found.length) await rm(path.join(this.directory, fileId), { force: true });
    } catch (error: unknown) {
      logCrewPhotoCleanupFailure(error);
    }
  }

  async upload(deliveryId:string,input:unknown,principal:OperatorActor) {
    const command=UploadSchema.parse(input);
    const file=inspectFile(command.name,command.base64);
    await validateFileContent(file);
    if(command.kind==='photo'&&!file.mime.startsWith('image/')) throw new BadRequestException('A photo requires image content');
    if(command.kind!=='document'&&(command.documentPurpose||command.supersedesFileId)) throw new BadRequestException('Document metadata requires a document');
    const id=command.requestId??randomUUID();
    const fingerprint=createHash('sha256').update(JSON.stringify({action:'file.upload',...command})).digest('hex');
    let replayed=false;
    await this.store.db.source.transaction(async(manager)=>{
      const delivery=await this.store.get(deliveryId,manager,true);
      if(command.requestId){
        const receipt=(await rows(manager,z.object({fingerprint:z.string()}),'SELECT fingerprint FROM command_receipt WHERE delivery_id=$1 AND request_id=$2',[deliveryId,command.requestId]))[0];
        if(receipt){
          if(receipt.fingerprint!==fingerprint) throw new ConflictException('Request ID reused with different upload data');
          replayed=true;return;
        }
        const existing=await rows(manager,z.object({id:IdSchema}),'SELECT id FROM file_record WHERE id=$1',[id]);
        if(existing.length) throw new ConflictException('Upload is pending or failed. Check its status before retrying with a new request ID.');
      }
      if(delivery.completedAt) throw new ConflictException('Reopen delivery before adding documents');
      if(command.appointmentId&&!delivery.appointments.some((appointment)=>appointment.id===command.appointmentId)) throw new BadRequestException('Appointment belongs to another delivery');
      if(command.itemId&&!delivery.source.items.some((item)=>item.sourceLineId===command.itemId)) throw new BadRequestException('Item belongs to another delivery');
      const issue=command.issueId?delivery.issues.find((entry)=>entry.id===command.issueId):undefined;
      if(command.issueId&&!issue) throw new BadRequestException('Issue belongs to another delivery');
      let documentVersion=command.kind==='document'?1:null;
      if(command.supersedesFileId){
        const [previous]=await rows(manager,FileSchema,`SELECT ${FILE_COLUMNS} FROM file_record f WHERE f.id=$1 AND f.delivery_id=$2`,[command.supersedesFileId,deliveryId]);
        if(!previous||previous.status!=='ready'||previous.kind!=='document') throw new BadRequestException('Choose a ready document from this delivery to replace');
        if(previous.appointmentId!==command.appointmentId||previous.itemId!==command.itemId||previous.issueId!==command.issueId) throw new BadRequestException('A replacement must keep the same visit, product line and issue');
        const replacements=await rows(manager,z.object({id:IdSchema}),`SELECT id FROM file_record WHERE supersedes_file_id=$1 AND status IN ('pending','ready')`,[previous.id]);
        if(replacements.length) throw new ConflictException('This document already has a newer version or a replacement in progress');
        documentVersion=(previous.documentVersion??0)+1;
      }
      await manager.query(`INSERT INTO file_record(id,delivery_id,actor_id,name,mime,size,kind,appointment_id,item_id,issue_id,status,
        document_purpose,document_version,document_source,supersedes_file_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [id,deliveryId,principal.id,command.name,file.mime,file.bytes.length,command.kind,command.appointmentId,command.itemId,command.issueId,'pending',
          command.kind==='document'?(command.documentPurpose??'general'):null,documentVersion,command.kind==='document'?'local_upload':null,command.supersedesFileId??null]);
      await this.store.audit(manager,principal,'file.upload_started',{id,name:command.name},deliveryId);
    });
    if(replayed) return this.store.detail(deliveryId);
    try{
      await mkdir(this.directory,{recursive:true});
      await writeFile(path.join(this.directory,id+'.pending'),file.bytes,{flag:'wx'});
      await rename(path.join(this.directory,id+'.pending'),path.join(this.directory,id));
      await this.store.db.source.transaction(async(manager)=>{
        const delivery=await this.store.get(deliveryId,manager,true);
        if(delivery.completedAt) throw new ConflictException('Delivery closed during upload; reopen it before adding files');
        await manager.query('UPDATE file_record SET status=$2 WHERE id=$1',[id,'ready']);
        const issue=delivery.issues.find((entry)=>entry.id===command.issueId);
        if(issue){issue.photoIds.push(id);delivery.version++;await this.store.save(manager,delivery);}
        await this.store.audit(manager,principal,'file.uploaded',{id,...(command.supersedesFileId?{supersedesFileId:command.supersedesFileId}:{})},deliveryId);
        if(command.requestId) await manager.query('INSERT INTO command_receipt(delivery_id,request_id,fingerprint) VALUES($1,$2,$3)',[deliveryId,command.requestId,fingerprint]);
      });
    }catch(error:unknown){
      await this.store.db.source.query('UPDATE file_record SET status=$2 WHERE id=$1',[id,'failed']);
      if(error instanceof BadRequestException) throw error;
      throw new ConflictException('Upload did not finish; no ready document was registered');
    }
    return this.store.detail(deliveryId);
  }
  async download(deliveryId:string,id:string) {
    // In this single-workspace prototype both authenticated roles can read all deliveries.
    await this.store.get(deliveryId);
    const file=(await rows(this.store.db.source.manager,FileSchema,`SELECT ${FILE_COLUMNS} FROM file_record f WHERE f.id=$1 AND f.delivery_id=$2`,[id,deliveryId]))[0];
    if(!file||file.status!=='ready') throw new NotFoundException('File is not available');
    return this.readStoredFile(file);
  }

  crewDocuments(deliveryId: string, appointmentId: string, sourceLineIds: number[], fileId: string | null = null, manager:EntityManager=this.store.db.source.manager) {
    return rows(manager,CrewDocumentSchema,`
      SELECT ${FILE_COLUMNS} FROM file_record f
      WHERE f.delivery_id=$1 AND f.kind='document' AND f.status='ready' AND f.issue_id IS NULL
        AND (f.appointment_id IS NULL OR f.appointment_id=$2)
        AND (f.item_id IS NULL OR f.item_id::bigint=ANY($3::bigint[]))
        AND ($4::uuid IS NULL OR f.id=$4)
        AND ($4::uuid IS NOT NULL OR NOT EXISTS(SELECT 1 FROM file_record replacement WHERE replacement.supersedes_file_id=f.id AND replacement.status='ready'))
      ORDER BY f.created_at,f.id LIMIT 200`, [deliveryId, appointmentId, sourceLineIds, fileId]);
  }

  async readStoredFile<T extends { id: string; size: number }>(file: T) {
    let bytes:Buffer;
    try{bytes=await readFile(path.join(this.directory,IdSchema.parse(file.id)));}catch{throw new NotFoundException('Stored file is missing; recovery is required');}
    if(bytes.length!==file.size) throw new ConflictException('Stored file is incomplete');
    return {file,bytes};
  }
}

function logCrewPhotoCleanupFailure(error: unknown) {
  console.error('Crew photo cleanup failed:', error instanceof Error ? error.name : 'Unknown error');
}
