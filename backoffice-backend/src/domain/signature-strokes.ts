import { z } from 'zod';

const Coordinate = z.number().int().min(0).max(1000);
const Point = z.object({ x: Coordinate, y: Coordinate }).strict();
type Point = z.infer<typeof Point>;

function hasInk(stroke: Point[]) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const { x, y } of stroke) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return maxX - minX >= 8 || maxY - minY >= 8;
}

export const SignatureStrokesSchema = z.array(z.array(Point).min(1).max(256)).min(1).max(32)
  .refine((strokes) => strokes.reduce((total, stroke) => total + stroke.length, 0) <= 2048,
    'A signature can contain at most 2048 points')
  .refine((strokes) => strokes.some(hasInk), 'Draw a signature before submitting')
  .describe('Normalized integer coordinates between 0 and 1000. At most 2048 points total. One stroke must span at least 8 units along either axis.');

type SignatureStrokes = z.infer<typeof SignatureStrokesSchema>;

function comparableDrawing(strokes: SignatureStrokes) {
  return JSON.stringify(strokes.map((stroke) => stroke
    .filter(({ x, y }, index) => {
      const previous = stroke[index - 1];
      return previous === undefined || previous.x !== x || previous.y !== y;
    })
    .map(({ x, y }) => [x, y])));
}

export function sameSignatureDrawing(first: SignatureStrokes, second: SignatureStrokes) {
  return comparableDrawing(first) === comparableDrawing(second);
}
