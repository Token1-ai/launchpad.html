import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';

const V6 = typeof ethers.JsonRpcProvider === 'function';
const mkProvider = u => V6 ? new ethers.JsonRpcProvider(u) : new ethers.providers.JsonRpcProvider(u);
const mkIface = a => V6 ? new ethers.Interface(a) : new ethers.utils.Interface(a);
const fmtEther = v => V6 ? ethers.formatEther(v) : ethers.utils.formatEther(v);
const isAddr = a => V6 ? ethers.isAddress(a) : ethers.utils.isAddress(a);
const ZERO = '0x0000000000000000000000000000000000000000';

// Два лаунчпада: старый со всеми уже созданными токенами и новый,
// где у людей без пропуска есть один бесплатный токен.
const LAUNCHPAD_V1 = '0xFf06CfB755f5d08eB0A60fC6fA56dc525DbAca0d';
const LAUNCHPAD_V2 = '0x672F6a4a78a1650617BFc5FA5E6B1428A594E5FE';
const LAUNCHPADS = [LAUNCHPAD_V1, LAUNCHPAD_V2];
const isLaunchpad = a => !!a && LAUNCHPADS.some(x => x.toLowerCase() === String(a).toLowerCase());
const RPCS = [
  'https://bsc-dataseed.binance.org/',
  'https://bsc-dataseed1.defibit.io/',
  'https://bsc-dataseed1.ninicoin.io/'
];
const EVENT_ABI = [
  'event Buy(address indexed token,address indexed buyer,uint256 bnbIn,uint256 tokensOut,uint256 newPrice)',
  'event Sell(address indexed token,address indexed seller,uint256 tokensIn,uint256 bnbOut,uint256 newPrice)'
];
const CURVE_ABI = ['function getCurve(address) view returns (address creator,uint256 realBNB,uint256 tokensSold,bool graduated,uint256 createdAt)'];

const clip = (s, n) => String(s || '').slice(0, n);
const safeUrl = s => { const v = clip(s, 200).trim(); return /^https?:\/\//i.test(v) ? v : ''; };
const verifyMsg = (m, sig) => V6 ? ethers.verifyMessage(m, sig) : ethers.utils.verifyMessage(m, sig);
const OWNER_WALLET = '0xC85b148F3EbD09e9072706166B4CD99cF7Ed3108';

// Подпись покрывает САМО содержимое, а не только адрес токена.
// Иначе тот, кто однажды увидел подпись, подставил бы под неё свой текст.
// Префикс отличается от пулов, чтобы подпись нельзя было использовать
// на другом разделе площадки.
function tokenMetaMessage(tokenAddress, m, ts) {
  return 'OpenGate Launch token metadata\n' +
    'token: ' + String(tokenAddress).toLowerCase() + '\n' +
    'image: ' + (m.image_url || '') + '\n' +
    'desc: '  + (m.description || '') + '\n' +
    'x: '     + (m.twitter || '') + '\n' +
    'tg: '    + (m.telegram || '') + '\n' +
    'web: '   + (m.website || '') + '\n' +
    'ts: '    + ts;
}

const sbClient = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const body = req.body || {};
  try {
    if (body.action === 'upload') return await doUpload(body, res);
    if (body.action === 'trade') return await doTrade(body, res);
    if (body.action === 'token') return await doToken(body, res);
    res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed' });
  }
}

async function doUpload(body, res) {
  const { name, type, dataBase64 } = body;
  if (!dataBase64) { res.status(400).json({ error: 'No file' }); return; }
  const buffer = Buffer.from(dataBase64, 'base64');
  if (buffer.length > 3 * 1024 * 1024) { res.status(413).json({ error: 'File too large (max 3MB)' }); return; }

  const fname = String(name || 'upload').replace(/["\r\n]/g, '');
  const boundary = '----OG' + Date.now().toString(16);
  const head = Buffer.from(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="file"; filename="' + fname + '"\r\n' +
    'Content-Type: ' + (type || 'application/octet-stream') + '\r\n\r\n'
  );
  const tail = Buffer.from('\r\n--' + boundary + '--\r\n');

  const r = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.PINATA_JWT,
      'Content-Type': 'multipart/form-data; boundary=' + boundary
    },
    body: Buffer.concat([head, buffer, tail])
  });
  if (!r.ok) { const t = await r.text(); res.status(502).json({ error: 'Pinata error', detail: t.slice(0, 200) }); return; }
  const j = await r.json();
  res.status(200).json({ url: 'https://gateway.pinata.cloud/ipfs/' + j.IpfsHash, hash: j.IpfsHash });
}

async function doTrade(body, res) {
  const { txHash, tokenAddress, wallet } = body;
  if (!txHash || !tokenAddress || !wallet) { res.status(400).json({ error: 'Missing params' }); return; }
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) { res.status(400).json({ error: 'Bad tx hash' }); return; }

  let receipt = null;
  for (const url of RPCS) {
    try { receipt = await mkProvider(url).getTransactionReceipt(txHash); if (receipt) break; } catch (e) {}
  }
  if (!receipt) { res.status(404).json({ error: 'Tx not found' }); return; }
  if (Number(receipt.status) !== 1) { res.status(400).json({ error: 'Tx failed' }); return; }
  if (!isLaunchpad(receipt.to)) { res.status(400).json({ error: 'Wrong contract' }); return; }

  const iface = mkIface(EVENT_ABI);
  let found = null;
  for (const log of receipt.logs) {
    if (!isLaunchpad(log.address)) continue;
    let p; try { p = iface.parseLog(log); } catch (e) { continue; }
    if (!p) continue;
    if (String(p.args.token).toLowerCase() !== tokenAddress.toLowerCase()) continue;
    if (p.name === 'Buy' && String(p.args.buyer).toLowerCase() === wallet.toLowerCase()) {
      found = { side: 'buy', bnb: p.args.bnbIn, tokens: p.args.tokensOut, price: p.args.newPrice }; break;
    }
    if (p.name === 'Sell' && String(p.args.seller).toLowerCase() === wallet.toLowerCase()) {
      found = { side: 'sell', bnb: p.args.bnbOut, tokens: p.args.tokensIn, price: p.args.newPrice }; break;
    }
  }
  if (!found) { res.status(400).json({ error: 'No matching trade event' }); return; }

  const sb = sbClient();
  const { data: existing } = await sb.from('launchpad_trades').select('id').eq('tx_hash', txHash).maybeSingle();
  if (existing) { res.status(200).json({ ok: true, duplicate: true }); return; }

  const { error } = await sb.from('launchpad_trades').insert({
    token_address: tokenAddress.toLowerCase(),
    wallet: wallet.toLowerCase(),
    side: found.side,
    bnb_amount: Number(fmtEther(found.bnb)),
    token_amount: Number(fmtEther(found.tokens)),
    price: Number(fmtEther(found.price)),
    tx_hash: txHash
  });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(200).json({ ok: true });
}

async function doToken(body, res) {
  const { tokenAddress, meta, ts, signature } = body;
  if (!tokenAddress || !meta || !signature) { res.status(400).json({ error: 'Missing params' }); return; }
  if (!isAddr(tokenAddress)) { res.status(400).json({ error: 'Bad address' }); return; }

  // Окно свежести: перехваченную подпись нельзя применить позже
  const tsNum = Number(ts);
  if (!isFinite(tsNum) || Math.abs(Date.now() - tsNum) > 10 * 60 * 1000) {
    res.status(400).json({ error: 'Signature expired — try again' }); return;
  }

  const clean = {
    description: clip(meta.description, 500),
    image_url:   safeUrl(meta.image_url),
    twitter:     safeUrl(meta.twitter),
    telegram:    safeUrl(meta.telegram),
    website:     safeUrl(meta.website)
  };

  let signer = null;
  try { signer = verifyMsg(tokenMetaMessage(tokenAddress, clean, tsNum), signature); } catch (e) {}
  if (!signer) { res.status(400).json({ error: 'Bad signature' }); return; }

  // Создателя берём ИЗ БЛОКЧЕЙНА, а не из запроса — это и есть суть правки
  // Токен может жить на любом из двух контрактов — спрашиваем оба
  let creator = null;
  outer:
  for (const url of RPCS) {
    for (const pad of LAUNCHPADS) {
      try {
        const lp = new ethers.Contract(pad, CURVE_ABI, mkProvider(url));
        const c = await lp.getCurve(tokenAddress);
        if (c[0] && c[0] !== ZERO) { creator = c[0]; break outer; }
      } catch (e) {}
    }
  }
  if (!creator || creator === ZERO) { res.status(404).json({ error: 'Token not found' }); return; }

  const allowed = creator.toLowerCase() === signer.toLowerCase()
               || signer.toLowerCase() === OWNER_WALLET.toLowerCase();
  if (!allowed) { res.status(403).json({ error: 'Only the token creator can edit this' }); return; }

  const sb = sbClient();
  // Название и тикер живут в контракте и не меняются: при правке берём старые
  const { data: ex } = await sb.from('launchpad_tokens').select('name,symbol').eq('address', tokenAddress.toLowerCase()).maybeSingle();

  const { error } = await sb.from('launchpad_tokens').upsert({
    address: tokenAddress.toLowerCase(),
    creator: creator.toLowerCase(),
    chain: 'bnb',
    name:   clip(meta.name, 64)   || (ex && ex.name)   || '',
    symbol: clip(meta.symbol, 16) || (ex && ex.symbol) || '',
    ...clean
  }, { onConflict: 'address' });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(200).json({ ok: true });
}
