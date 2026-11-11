export type SignaturePoint = { x: number; y: number };
export type SignatureStrokes = SignaturePoint[][];

export const signatureExtent = 1000;
const maxStrokes = 32;
const maxPointsPerStroke = 256;
const maxTotalPoints = 2048;
const minimumInkSpan = 8;

export function signaturePoint(clientX: number, clientY: number, surface: { left: number; top: number; width: number; height: number }): SignaturePoint | null {
  if (surface.width <= 0 || surface.height <= 0) return null;
  const normalize = (position: number) => Math.round(Math.max(0, Math.min(1, position)) * signatureExtent);
  return { x: normalize((clientX - surface.left) / surface.width), y: normalize((clientY - surface.top) / surface.height) };
}

function totalPoints(strokes: SignatureStrokes) {
  return strokes.reduce((count, stroke) => count + stroke.length, 0);
}

export function startSignatureStroke(strokes: SignatureStrokes, point: SignaturePoint): SignatureStrokes {
  if (strokes.length >= maxStrokes || totalPoints(strokes) >= maxTotalPoints - 1) return strokes;
  return [...strokes, [point]];
}

export function extendSignatureStroke(strokes: SignatureStrokes, point: SignaturePoint): SignatureStrokes {
  const stroke = strokes.at(-1);
  const previous = stroke?.at(-1);
  if (!stroke || !previous || (previous.x === point.x && previous.y === point.y)) return strokes;

  // Reduce old samples on a long stroke while keeping the start and last recorded points.
  const preceding = strokes.slice(0, -1);
  const hasSpace = stroke.length < maxPointsPerStroke && totalPoints(strokes) < maxTotalPoints;
  const samples = hasSpace ? stroke : stroke.filter((_, index) => index % 2 === 0 || index === stroke.length - 1);
  if (totalPoints(preceding) + samples.length >= maxTotalPoints) return strokes;
  return [...preceding, [...samples, point]];
}

export function signatureHasInk(strokes: SignatureStrokes) {
  return strokes.some((stroke) => {
    const x = stroke.map((point) => point.x);
    const y = stroke.map((point) => point.y);
    return Math.max(...x) - Math.min(...x) >= minimumInkSpan || Math.max(...y) - Math.min(...y) >= minimumInkSpan;
  });
}

export function signatureDraftScope(version: number, responsibleId: string | null, draftRevision: number) {
  return `${version}/${responsibleId ?? ''}/${draftRevision}`;
}

export type SignaturePair = { customer: SignatureStrokes; crew: SignatureStrokes };
export const emptySignatures: SignaturePair = { customer: [], crew: [] };

export function currentSignatures(draft: { scope: string; pair: SignaturePair } | null, scope: string): SignaturePair {
  return draft?.scope === scope ? draft.pair : emptySignatures;
}

export function isSignerName(value: string) {
  return value.length >= 1 && value.length <= 200 && Array.from(value).every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && (code < 127 || code > 159);
  });
}

export function signatureInputFingerprint(fields: FormData) {
  return JSON.stringify(Array.from(fields.entries(), ([key, value]) => [key, typeof value === 'string' ? value : null]));
}
