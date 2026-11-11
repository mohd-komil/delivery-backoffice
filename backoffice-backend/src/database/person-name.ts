export const PERSON_NAME_SQL = "COALESCE(p.preferred_name,NULLIF(concat_ws(' ',p.first_name,p.last_name),''),p.legacy_name)";
