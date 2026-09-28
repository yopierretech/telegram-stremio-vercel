import { Api, DEFAULT_API_ID, DEFAULT_API_HASH, makeClient, closeClient, seal, open } from '../lib/tg.js';

// Stateless login: the temporary Telegram session + phoneCodeHash travel back and forth
// inside an encrypted "pending" blob, so nothing is stored on the server.
// Each user brings their OWN api_id / api_hash (from my.telegram.org), so no shared credentials are used.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    return res.json({
      needsSitePassword: !!process.env.SITE_PASSWORD,
      hasDefaultCreds: !!(DEFAULT_API_ID && DEFAULT_API_HASH),
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const body = req.body || {};
  const sitePw = process.env.SITE_PASSWORD;
  if (sitePw && body.sitePassword !== sitePw) return res.status(401).json({ error: 'סיסמת אתר שגויה' });

  let client;
  try {
    if (body.step === 'phone') {
      const phone = String(body.phone || '').trim();
      let a = String(body.apiId || '').trim();
      let h = String(body.apiHash || '').trim();
      if (!a && !h) {
        a = String(DEFAULT_API_ID || '');
        h = DEFAULT_API_HASH;
      }
      if (!/^\d{4,10}$/.test(a) || !/^[0-9a-f]{32}$/i.test(h)) {
        return res.json({ error: 'api_id / api_hash לא תקינים' });
      }
      client = await makeClient('', a, h);
      const r = await client.sendCode({ apiId: Number(a), apiHash: h }, phone);
      return res.json({
        via: r.isCodeViaApp ? 'app' : 'other',
        pending: seal({ s: client.session.save(), a, h, phone, hash: r.phoneCodeHash, t: Date.now() }),
      });
    }

    const p = open(body.pending);
    if (Date.now() - p.t > 15 * 60 * 1000) return res.json({ error: 'פג תוקף, התחל מחדש' });
    client = await makeClient(p.s, p.a, p.h);

    if (body.step === 'resend') {
      // Ask Telegram to deliver the code again through the next available channel (usually SMS).
      const sent = await client.invoke(new Api.auth.ResendCode({ phoneNumber: p.phone, phoneCodeHash: p.hash }));
      return res.json({
        via: String(sent.type?.className || ''),
        pending: seal({ ...p, s: client.session.save(), hash: sent.phoneCodeHash }),
      });
    }

    if (body.step === 'code') {
      try {
        await client.invoke(
          new Api.auth.SignIn({
            phoneNumber: p.phone,
            phoneCodeHash: p.hash,
            phoneCode: String(body.code || '').trim(),
          })
        );
      } catch (e) {
        if (e.errorMessage === 'SESSION_PASSWORD_NEEDED') return res.json({ needPassword: true });
        throw e;
      }
      return res.json({ token: seal({ s: client.session.save(), a: p.a, h: p.h }) });
    }

    if (body.step === 'password') {
      await client.signInWithPassword(
        { apiId: Number(p.a), apiHash: p.h },
        {
          password: async () => String(body.password || ''),
          onError: async (err) => {
            throw err;
          },
        }
      );
      return res.json({ token: seal({ s: client.session.save(), a: p.a, h: p.h }) });
    }

    res.status(400).json({ error: 'bad step' });
  } catch (e) {
    res.json({ error: e.errorMessage || e.message });
  } finally {
    await closeClient(client);
  }
}
