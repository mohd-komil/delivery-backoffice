// Shared SQL projection; callers use the fixed alias f and parameterized predicates.
export const FILE_COLUMNS = `f.id,f.delivery_id AS "deliveryId",f.name,f.mime,f.size,f.kind,
  f.appointment_id AS "appointmentId",f.item_id AS "itemId",f.issue_id AS "issueId",f.status,f.created_at::text AS "createdAt",
  f.document_purpose AS "documentPurpose",f.document_version AS "documentVersion",
  f.document_source AS "documentSource",f.supersedes_file_id AS "supersedesFileId",
  (SELECT jsonb_build_object('id',u.id,'name',u.name) FROM app_user u WHERE u.id=f.actor_id) AS "uploadedBy"`;
