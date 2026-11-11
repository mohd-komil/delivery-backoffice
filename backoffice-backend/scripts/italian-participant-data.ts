import { z } from 'zod';

export const ItalianParticipantFixtureSchema=z.object({
  id:z.string().uuid(),firstName:z.string().min(1),lastName:z.string().min(1),preferredName:z.string().min(1),
  phoneNumber:z.string().startsWith('+39 000 '),address:z.string().includes('(indirizzo fittizio)'),
  login:z.string().endsWith('@example.test'),
}).strict();
export type ItalianParticipantFixture=z.infer<typeof ItalianParticipantFixtureSchema>;

function fixture(id:string,firstName:string,lastName:string,preferredFirst:string,city:string,number:number):ItalianParticipantFixture {
  return ItalianParticipantFixtureSchema.parse({id,firstName,lastName,preferredName:`${preferredFirst} ${lastName}`,
    phoneNumber:`+39 000 100 ${String(number).padStart(4,'0')}`,
    address:`Via del Prototipo ${100+number}, ${city} (indirizzo fittizio)`,
    login:`${firstName}.${lastName.replaceAll(' ','')}.demo@example.test`.toLowerCase()});
}

// Exact UUIDs are authoritative; equal old display names never identify the same person.
export const italianParticipantData:readonly ItalianParticipantFixture[]=[
  fixture('20000000-0000-4000-8000-000000000001','Salvatore','Romano','Totò','Messina',1),
  fixture('20000000-0000-4000-8000-000000000002','Giuseppe','Caruso','Pippo','Messina',2),
  fixture('20000000-0000-4000-8000-000000000003','Francesco','Greco','Francesco','Messina',3),
  fixture('20000000-0000-4000-8000-000000000004','Giovanni','Rizzo','Gianni','Messina',4),
  fixture('20000000-0000-4000-8000-000000000005','Antonio','Lombardo','Antonio','Messina',5),
  fixture('20000000-0000-4000-8000-000000000006','Carmelo','Puglisi','Carmelo','Messina',6),
  fixture('20000000-0000-4000-8000-000000000007','Marco','Russo','Marco','Catania',7),
  fixture('20000000-0000-4000-8000-000000000008','Luca','Marino','Luca','Catania',8),
  fixture('20000000-0000-4000-8000-000000000009','Alessandro','Costa','Alessandro','Catania',9),
  fixture('20000000-0000-4000-8000-000000000010','Matteo','Ferraro','Matteo','Catania',10),
  fixture('20000000-0000-4000-8000-000000000011','Davide','Vitale','Davide','Catania',11),
  fixture('20000000-0000-4000-8000-000000000012','Andrea','Grasso','Andrea','Catania',12),
  fixture('20000000-0000-4000-8000-000000000013','Roberto','Giordano','Roberto','Catania',13),
  fixture('20000000-0000-4000-8000-000000000014','Stefano','Basile','Stefano','Catania',14),
  fixture('20000000-0000-4000-8000-000000000015','Paolo','Mancini','Paolo','Catania',15),
  fixture('20000000-0000-4000-8000-000000000016','Elena','Moretti','Elena','Catania',16),
  fixture('20000000-0000-4000-8000-000000000017','Giulia','Santoro','Giulia','Catania',17),
  fixture('20000000-0000-4000-8000-000000000018','Francesca','Conti','Francesca','Catania',18),
  fixture('105cda4e-5e6c-46bb-9e06-cb0648620d74','Valentina','Messina','Valentina','Catania',19),
  fixture('394f4f47-b646-477c-8794-192a26d90c83','Simone','Lo Presti','Simone','Catania',20),
];
export const italianParticipantById:ReadonlyMap<string,ItalianParticipantFixture>=new Map(italianParticipantData.map((person)=>[person.id,person]));
if(italianParticipantById.size!==20||new Set(italianParticipantData.map((person)=>person.login)).size!==20) throw new Error('Italian demo catalog identities/logins must be unique');
