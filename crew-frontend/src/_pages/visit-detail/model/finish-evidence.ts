import type { FinishLineQuantity } from './quantity';
import { isSignerName, signatureHasInk, type SignaturePair, type SignatureStrokes } from './signature';

export const refusalReasonMaxLength = 2000;

export type FinishEvidence = { crewSignature: { strokes: SignatureStrokes } } & (
  | { customerSignature: { signerName: string; strokes: SignatureStrokes }; signatureRefusal?: never }
  | { customerSignature?: never; signatureRefusal: { reason: string; noPhotoReason?: string } }
);

export type FinishEvidenceError =
  | { field: 'photos' | 'customerName' | 'signatureDuplicate' | 'refusalWork' | 'refusalReason' | 'noPhotoReason' | 'refusalPhotoConflict' }
  | { field: 'signature'; role: keyof SignaturePair };

function explanation(fields: FormData, name: string) {
  const value = fields.get(name);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= refusalReasonMaxLength ? trimmed : null;
}

export function readFinishEvidence(fields: FormData, signatures: SignaturePair, quantities: readonly FinishLineQuantity[], photoCount: number):
  { ok: true; evidence: FinishEvidence } | { ok: false; error: FinishEvidenceError } {
  const crewSignature = { strokes: signatures.crew };
  if (fields.get('signatureOutcome') === 'refused') {
    if (!quantities.some(({ deliveredMilli, installedMilli, collectedMilli }) =>
      deliveredMilli > 0 || (installedMilli ?? 0) > 0 || (collectedMilli ?? 0) > 0)) {
      return { ok: false, error: { field: 'refusalWork' } };
    }
    const reason = explanation(fields, 'refusalReason');
    if (!reason) return { ok: false, error: { field: 'refusalReason' } };
    const prohibited = fields.get('photoProhibited') === 'yes';
    const noPhotoReason = prohibited ? explanation(fields, 'noPhotoReason') : null;
    if (prohibited && !noPhotoReason) return { ok: false, error: { field: 'noPhotoReason' } };
    if (prohibited && photoCount > 0) return { ok: false, error: { field: 'refusalPhotoConflict' } };
    if (!prohibited && photoCount === 0) return { ok: false, error: { field: 'photos' } };
    if (!signatureHasInk(signatures.crew)) return { ok: false, error: { field: 'signature', role: 'crew' } };
    return { ok: true, evidence: { crewSignature, signatureRefusal: { reason, ...(noPhotoReason ? { noPhotoReason } : {}) } } };
  }

  if (photoCount === 0) return { ok: false, error: { field: 'photos' } };
  const rawSignerName = fields.get('customerSignerName');
  const signerName = typeof rawSignerName === 'string' ? rawSignerName.trim() : '';
  if (!isSignerName(signerName)) return { ok: false, error: { field: 'customerName' } };
  if (!signatureHasInk(signatures.customer)) return { ok: false, error: { field: 'signature', role: 'customer' } };
  if (!signatureHasInk(signatures.crew)) return { ok: false, error: { field: 'signature', role: 'crew' } };
  if (JSON.stringify(signatures.customer) === JSON.stringify(signatures.crew)) return { ok: false, error: { field: 'signatureDuplicate' } };
  return { ok: true, evidence: { crewSignature, customerSignature: { signerName, strokes: signatures.customer } } };
}
