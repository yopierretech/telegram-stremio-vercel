import crypto from 'node:crypto';
import { Api, bigInt, makeClient, closeClient, open } from '../lib/tg.js';

const PAGE = 50;
const CHUNK = 512 * 1024;
const MAX_SEARCH = Number(process.env.MAX_SEARCH_CHANNELS || 15);
const MSG_FILTER = (process.env.MSG_FILTER || 'video').toLowerCase();
const VIDEO_EXT = /\.(mkv|mp4|avi|mov|webm|m4v|ts|wmv|flv)$/i;

// ---------- helpers ----------
const dlgCache = new Map(); // warm-instance cache of the channel list (data only, no connections)

async function channels(client, token) {
  const k = crypto.createHash('sha1').update(token).digest('hex');
  const hit = dlgCache.get(k);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.list;
  const ds = await client.getDialogs({ limit: 300 });
  const list = ds
    .filter((d) => (d.isChannel || d.isGroup) && d.entity)
    .map((d) => ({
      title: d.title || 'Untitled',
      kind: d.entity.className === 'Channel' ? 'c' : 'g',
      id: String(d.entity.id),
      hash: String(d.entity.accessHash ?? 0),
    }));
  dlgCache.set(k, { at: Date.now(), list });
  return list;
}

// Ids carry the peer's accessHash, so meta/stream/file need no dialog lookup.
function peerOf(kind, id, hash) {
  return kind === 'c'
    ? new Api.InputPeerChannel({ channelId: bigInt(id), accessHash: bigInt(hash) })
    : new Api.InputPeerChat({ chatId: bigInt(id) });
}

async function getMsg(client, kind, id, hash, msgId) {
  const [m] = await client.getMessages(peerOf(kind, id, hash), { ids: Number(msgId) });
  return m;
}

const tgFilter = () =>
  MSG_FILTER === 'document' ? new Api.InputMessagesFilterDocument() : new Api.InputMessagesFilterVideo();

function videoInfo(m) {
  const doc = m?.media?.document;
  if (!doc) return null;
  const attrs = doc.attributes || [];
  const fileName = attrs.find((a) => a.className === 'DocumentAttributeFilename')?.fileName || '';
  const vid = attrs.find((a) => a.className === 'DocumentAttributeVideo');
  const mime = doc.mimeType || '';
  if (!mime.startsWith('video/') && !VIDEO_EXT.test(fileName)) return null;
  let mimeType = mime;
  if (!mime.startsWith('video/')) mimeType = /\.mkv$/i.test(fileName) ? 'video/x-matroska' : 'video/mp4';
  return { doc, fileName, mimeType, size: Number(doc.size), duration: vid ? Math.round(vid.duration) : 0 };
}

function titleOf(m, info) {
  if (info.fileName) return info.fileName.replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ').trim();
  return (m.message || '').split('\n')[0].slice(0, 80) || `Video ${m.id}`;
}

function toMeta(prefix, ch, m) {
  const info = videoInfo(m);
  if (!info) return null;
  const hasThumb = (info.doc.thumbs || []).some((t) => t.className === 'PhotoSize');
  return {
    id: `tg:${ch.kind}:${ch.id}:${ch.hash}:${m.id}`,
    type: 'movie',
    name: titleOf(m, info),
    poster: hasThumb ? `${prefix}/thumb/${ch.kind}/${ch.id}/${ch.hash}/${m.id}.jpg` : undefined,
    posterShape: 'landscape',
    description: `${ch.title}\n${(info.size / 1024 / 1024 / 1024).toFixed(2)} GB${m.message ? '\n\n' + m.message : ''}`,
    runtime: info.duration ? `${Math.round(info.duration / 60)} min` : undefined,
  };
}

function parseId(raw) {
  let s = String(raw);
  try {
    s = decodeURIComponent(s);
  } catch {}
  const [, kind, id, hash, msg] = s.split(':');
  return { kind, id, hash, msg };
}

// ---------- handler ----------
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');

  const { r, token } = req.query;
  let creds;
  try {
    creds = open(token);
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const prefix = `https://${host}/${token}`;
  let client;

  try {
    client = await makeClient(creds.s, creds.a, creds.h);

    if (r === 'manifest') {
      let genres = ['Login required'];
      try {
        genres = [...new Set((await channels(client, token)).map((d) => d.title))];
      } catch {}
      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        id: 'community.telegram.channels',
        version: '1.0.0',
        name: 'Telegram Channels',
        description: 'Streams video files from the Telegram channels your account is a member of.',
        resources: ['catalog', 'meta', 'stream'],
        types: ['movie'],
        idPrefixes: ['tg:'],
        catalogs: [
          { type: 'movie', id: 'tg-channel', name: 'Telegram', extra: [{ name: 'genre', options: genres, isRequired: true }, { name: 'skip' }] },
          { type: 'movie', id: 'tg-search', name: 'Telegram Search', extra: [{ name: 'search', isRequired: true }, { name: 'skip' }] },
        ],
        behaviorHints: { configurable: false },
      });
    }

    if (r === 'catalog') {
      const extra = Object.fromEntries(new URLSearchParams(req.query.extra || ''));
      const skip = Number(extra.skip || 0);
      const list = await channels(client, token);
      const metas = [];

      if (req.query.id === 'tg-channel') {
        const ch = list.find((d) => d.title === extra.genre);
        if (ch) {
          const msgs = await client.getMessages(peerOf(ch.kind, ch.id, ch.hash), { limit: PAGE, addOffset: skip, filter: tgFilter() });
          for (const m of msgs) {
            const meta = toMeta(prefix, ch, m);
            if (meta) metas.push(meta);
          }
        }
      } else if (req.query.id === 'tg-search' && extra.search) {
        const results = await Promise.all(
          list.slice(0, MAX_SEARCH).map((ch) =>
            client
              .getMessages(peerOf(ch.kind, ch.id, ch.hash), { search: extra.search, limit: 10, filter: tgFilter() })
              .then((ms) => ms.map((m) => [ch, m]))
              .catch(() => [])
          )
        );
        for (const [ch, m] of results.flat()) {
          const meta = toMeta(prefix, ch, m);
          if (meta) metas.push(meta);
        }
      }
      res.setHeader('Cache-Control', 'public, s-maxage=60');
      return res.json({ metas });
    }

    if (r === 'meta') {
      const { kind, id, hash, msg } = parseId(req.query.id);
      const m = await getMsg(client, kind, id, hash, msg);
      const list = await channels(client, token).catch(() => []);
      const ch = list.find((d) => d.kind === kind && d.id === id) || { kind, id, hash, title: 'Telegram' };
      return res.json({ meta: (m && toMeta(prefix, ch, m)) || { id: req.query.id, type: 'movie', name: 'Unavailable' } });
    }

    if (r === 'stream') {
      const { kind, id, hash, msg } = parseId(req.query.id);
      const info = videoInfo(await getMsg(client, kind, id, hash, msg));
      if (!info) return res.json({ streams: [] });
      return res.json({
        streams: [
          {
            name: 'Telegram',
            title: `${info.fileName || 'video'}\n${(info.size / 1024 / 1024).toFixed(0)} MB`,
            url: `${prefix}/file/${kind}/${id}/${hash}/${msg}`,
            behaviorHints: {
              notWebReady: info.mimeType !== 'video/mp4',
              filename: info.fileName || undefined,
              videoSize: info.size,
            },
          },
        ],
      });
    }

    if (r === 'thumb') {
      const { kind, chat, hash, msg } = req.query;
      const m = await getMsg(client, kind, chat, hash, msg);
      const sizes = (m?.media?.document?.thumbs || []).filter((t) => t.className === 'PhotoSize');
      if (!sizes.length) return res.status(404).end();
      const best = sizes.reduce((a, b) => (b.size > a.size ? b : a));
      const buf = await client.downloadMedia(m, { thumb: best });
      if (!buf) return res.status(404).end();
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=604800, s-maxage=604800');
      return res.end(buf);
    }

    if (r === 'file') {
      const { kind, chat, hash, msg } = req.query;
      const info = videoInfo(await getMsg(client, kind, chat, hash, msg));
      if (!info) return res.status(404).end();
      const size = info.size;

      let start = 0;
      let end = size - 1;
      const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
      if (range) {
        if (range[1] !== '') {
          start = Number(range[1]);
          if (range[2] !== '') end = Math.min(Number(range[2]), size - 1);
        } else if (range[2] !== '') {
          start = Math.max(size - Number(range[2]), 0);
        }
        if (start > end || start >= size) {
          res.setHeader('Content-Range', `bytes */${size}`);
          return res.status(416).end();
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      }
      res.setHeader('Content-Type', info.mimeType);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', String(end - start + 1));

      // Telegram needs chunk-aligned offsets: align down and trim the first chunk.
      const aligned = start - (start % CHUNK);
      let skipBytes = start - aligned;
      let remaining = end - start + 1;
      let closed = false;
      res.on('close', () => (closed = true));

      for await (const chunk of client.iterDownload({ file: info.doc, offset: bigInt(aligned), requestSize: CHUNK })) {
        if (closed) break;
        let buf = chunk;
        if (skipBytes) {
          buf = buf.subarray(skipBytes);
          skipBytes = 0;
        }
        if (buf.length > remaining) buf = buf.subarray(0, remaining);
        if (!res.write(buf)) await new Promise((ok) => { res.once('drain', ok); res.once('close', ok); });
        remaining -= buf.length;
        if (remaining <= 0) break;
      }
      return res.end();
    }

    res.status(404).json({ error: 'not found' });
  } catch (e) {
    console.error(r, e.message);
    if (res.headersSent) return res.destroy();
    const fallback = {
      catalog: { metas: [] },
      stream: { streams: [] },
      meta: { meta: { id: 'x', type: 'movie', name: 'Unavailable' } },
    }[r];
    if (fallback) return res.json(fallback);
    res.status(500).end();
  } finally {
    await closeClient(client);
  }
}
