import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

function scryptAsync(password: string, salt: string) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = await scryptAsync(password, salt);
  return salt + ':' + key.toString('hex');
}

export async function verifyPassword(password: string, encoded: string) {
  const [salt, hash] = encoded.split(':');
  if (!salt || !hash || !/^[0-9a-f]{128}$/.test(hash)) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = await scryptAsync(password, salt);
  return timingSafeEqual(actual, expected);
}

const DummyPasswordHash = '0'.repeat(32) + ':' + '0'.repeat(128);

export async function verifyLoginPassword(password: string, encoded?: string) {
  const valid = await verifyPassword(password, encoded ?? DummyPasswordHash);
  return encoded !== undefined && valid;
}
