import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';

const V6 = typeof ethers.JsonRpcProvider === 'function';
const mkProvider = u => V6 ? new ethers.JsonRpcProvider(u) : new ethers.providers.JsonRpcProvider(u);
const mkIface = a => V6 ? new ethers.Interface(a) : new ethers.utils.Interface(a);
const fmtEther = v => V6 ? ethers.formatEther(v) : ethers.utils.formatEther(v);
const isAddr = a => V6 ? ethers.isAddress(a) : ethers.utils.isAddress(a);
const ZERO = '0x0000000000000000000000000000000000000000';

const LAUNCHPAD = '0x24DB137722507515E28A295717b73bB074192931';
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
  if (!receipt.to || receipt.to.toLowerCase() !== LAUNCHPAD.toLowerCase()) { res.status(400).json({ error: 'Wrong contract' }); return; }

  const iface = mkIface(EVENT_ABI);
  let found = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== LAUNCHPAD.toLowerCase()) continue;
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
  const { tokenAddress, wallet, meta } = body;
  if (!tokenAddress || !wallet || !meta) { res.status(400).json({ error: 'Missing params' }); return; }
  if (!isAddr(tokenAddress) || !isAddr(wallet)) { res.status(400).json({ error: 'Bad address' }); return; }

  let creator = null;
  for (const url of RPCS) {
    try {
      const lp = new ethers.Contract(LAUNCHPAD, CURVE_ABI, mkProvider(url));
      const c = await lp.getCurve(tokenAddress);
      creator = c[0];
      break;
    } catch (e) {}
  }
  if (!creator || creator === ZERO) { res.status(404).json({ error: 'Token not found' }); return; }
  if (creator.toLowerCase() !== wallet.toLowerCase()) { res.status(403).json({ error: 'Not token creator' }); return; }

  const sb = sbClient();
  const { data: ex } = await sb.from('launchpad_tokens').select('creator').eq('address', tokenAddress.toLowerCase()).maybeSingle();
  if (ex && ex.creator && ex.creator.toLowerCase() !== wallet.toLowerCase()) { res.status(403).json({ error: 'Already owned' }); return; }

  const { error } = await sb.from('launchpad_tokens').upsert({
    address: tokenAddress.toLowerCase(),
    creator: wallet.toLowerCase(),
    chain: 'bnb',
    name: clip(meta.name, 64),
    symbol: clip(meta.symbol, 16),
    description: clip(meta.description, 500),
    image_url: safeUrl(meta.image_url),
    twitter: safeUrl(meta.twitter),
    telegram: safeUrl(meta.telegram),
    website: safeUrl(meta.website)
  }, { onConflict: 'address' });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(200).json({ ok: true });
}
