import type { Response } from 'express';

export function sendPrivateDownload(response: Response<unknown>, result: { file: { name: string; mime: string }; bytes: Buffer }) {
  response.setHeader('Content-Type', result.file.mime);
  response.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(result.file.name));
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
  response.send(result.bytes);
}
