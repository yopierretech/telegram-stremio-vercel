import crypto from 'node:crypto';
import bigInt from 'big-integer';
import tg from 'telegram';
import sessions from 'telegram/sessions/index.js';

const { TelegramClient, Api } = tg;
const { StringSession } = sessions;

export { Api, bigInt };
// Optional owner defaults. In public mode every user supplies their own api_id / api_hash.
export const DEFAULT_API_ID = Number(process.env.TG_API_ID) || 0;
export const DEFAULT_API_HASH = process.env.TG_API_HASH || '';

function key() {
  const k = process.env.SECRET_KEY;
  if (!k || k.length < 16) throw new Error('SECRET_KEY env var (16+ chars) is required');
  return crypto.createHash('sha256').update(k).digest();
}

// The token embedded in the addon URL is the Telegram session, encrypted with SECRET_KEY (AES-256-GCM).
export function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64url');
}

export function open(token) {
  const b = Buffer.from(String(token), 'base64url');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
}

export async function makeClient(session = '', apiId = DEFAULT_API_ID, apiHash = DEFAULT_API_HASH) {
  if (!apiId || !apiHash) throw new Error('missing api_id / api_hash');
  const c = new TelegramClient(new StringSession(session), Number(apiId), apiHash, { connectionRetries: 3 });
  c.setLogLevel('error');
  await c.connect();
  return c;
}

export async function closeClient(c) {
  if (!c) return;
  try {
    await Promise.race([c.destroy(), new Promise((r) => setTimeout(r, 1500))]);
  } catch {}
}
