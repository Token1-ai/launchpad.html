import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';

const V6 = typeof ethers.JsonRpcProvider === 'function';
const mkProvider = u => V6 ? new ethers.JsonRpcProvider(u) : new ethers.providers.JsonRpcProvider(u);
const mkIface = a => V6 ? new ethers.Interface(a) : new ethers.utils.Interface(a);
const fmtEther = v => V6 ? ethers.formatEther(v) : ethers.utils.formatEther(v);

const POOLS = '0xe848d695801EfF59B13104493aAD8Eeb24935663';
const RPCS = [
  'https://bnb-mainnet.g.alchemy.com/v2/9xLdJVjBnhaD8S0QJZcBA',
  'https://bnb-mainnet.g.alchemy.com/v2/9xLdJVjBnhaD8S0QJZcBA',
  'https://bsc-dataseed.binance.org/'
];
const EVENT_ABI = [
  'event Buy(uint256 indexed poolId,address indexed buyer,uint256 quoteIn,uint256 tokensOut,uint256 newPrice)',
  'event Sell(uint256 indexed poolId,address indexed seller,uint256 tokensIn,uint256 quoteOut,uint256 newPrice)'
];

const verifyMsg = (m, sig) => V6 ? ethers.verifyMessage(m, sig) : ethers.utils.verifyMessage(m, sig);
const isAddr = a => V6 ? ethers.isAddress(a) : ethers.utils.isAddress(a);
const safeUrl = v => { const x = String(v || '').trim().slice(0, 300); return /^https?:\/\//i.test(x) ? x : ''; };

const OWNER_WALLET = '0xC85b148F3EbD09e9072706166B4CD99cF7Ed3108';
const POOLS_META_ABI = [
  'function poolByTokenQuote(address,uint8) view returns (uint256)',
  'function getPool(uint256) view returns (address token,uint8 quote,uint256 reserveToken,uint256 reserveQuote,address creator,bool locked,bool liquidityPulled,uint256 createdAt)'
];

// Подпись покрывает САМО содержимое. Если бы она покрывала только адрес токена,
// любой, кто однажды увидел подпись, мог бы подставить под неё чужой текст.
function metaMessage(tokenAddress, m, ts) {
  return 'OpenGate LaunchLab token metadata\n' +
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
    if (body.action === 'trade') return await doTrade(body, res);
    if (body.action === 'meta')  return await doMeta(body, res);
    res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed' });
  }
}

async function doTrade(body, res) {
  const { txHash, poolId, wallet } = body;
  if (!txHash || poolId === undefined || !wallet) { res.status(400).json({ error: 'Missing params' }); return; }
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) { res.status(400).json({ error: 'Bad tx hash' }); return; }

  let receipt = null;
  for (const url of RPCS) {
    try { receipt = await mkProvider(url).getTransactionReceipt(txHash); if (receipt) break; } catch (e) {}
  }
  if (!receipt) { res.status(404).json({ error: 'Tx not found' }); return; }
  if (Number(receipt.status) !== 1) { res.status(400).json({ error: 'Tx failed' }); return; }
  if (!receipt.to || receipt.to.toLowerCase() !== POOLS.toLowerCase()) { res.status(400).json({ error: 'Wrong contract' }); return; }

  const iface = mkIface(EVENT_ABI);
  let found = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== POOLS.toLowerCase()) continue;
    let p; try { p = iface.parseLog(log); } catch (e) { continue; }
    if (!p) continue;
    if (String(p.args.poolId) !== String(poolId)) continue;
    if (p.name === 'Buy' && String(p.args.buyer).toLowerCase() === wallet.toLowerCase()) {
      found = { side: 'buy', quote: p.args.quoteIn, token: p.args.tokensOut, price: p.args.newPrice }; break;
    }
    if (p.name === 'Sell' && String(p.args.seller).toLowerCase() === wallet.toLowerCase()) {
      found = { side: 'sell', quote: p.args.quoteOut, token: p.args.tokensIn, price: p.args.newPrice }; break;
    }
  }
  if (!found) { res.status(400).json({ error: 'No matching trade event' }); return; }

  const sb = sbClient();
  const { data: existing } = await sb.from('pool_trades').select('id').eq('tx_hash', txHash).maybeSingle();
  if (existing) { res.status(200).json({ ok: true, duplicate: true }); return; }

  const { error } = await sb.from('pool_trades').insert({
    pool_id: Number(poolId),
    wallet: wallet.toLowerCase(),
    side: found.side,
    quote_amount: Number(fmtEther(found.quote)),
    token_amount: Number(fmtEther(found.token)),
    price: Number(fmtEther(found.price)),
    tx_hash: txHash
  });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(200).json({ ok: true });
}

async function doMeta(body, res) {
  const { tokenAddress, signature, ts, meta } = body;
  if (!tokenAddress || !isAddr(tokenAddress)) { res.status(400).json({ error: 'Bad token address' }); return; }
  if (!signature || !meta) { res.status(400).json({ error: 'Missing params' }); return; }

  // Свежесть подписи: старую перехваченную нельзя применить через сутки
  const tsNum = Number(ts);
  if (!isFinite(tsNum) || Math.abs(Date.now() - tsNum) > 10 * 60 * 1000) {
    res.status(400).json({ error: 'Signature expired — try again' }); return;
  }

  const clean = {
    description: String(meta.description || '').trim().slice(0, 500),
    image_url:   safeUrl(meta.image_url),
    twitter:     safeUrl(meta.twitter),
    telegram:    safeUrl(meta.telegram),
    website:     safeUrl(meta.website)
  };

  let signer = null;
  try { signer = verifyMsg(metaMessage(tokenAddress, clean, tsNum), signature); } catch (e) {}
  if (!signer) { res.status(400).json({ error: 'Bad signature' }); return; }

  // Право на правку есть у создателя пула по этому токену и у владельца площадки
  let allowed = signer.toLowerCase() === OWNER_WALLET.toLowerCase();
  if (!allowed) {
    let creator = null;
    for (const url of RPCS) {
      try {
        const c = new ethers.Contract(POOLS, POOLS_META_ABI, mkProvider(url));
        for (const q of [0, 1, 2]) {
          const pid = await c.poolByTokenQuote(tokenAddress, q);
          if (Number(pid) > 0) { creator = String((await c.getPool(pid)).creator); break; }
        }
        break;
      } catch (e) {}
    }
    if (!creator) { res.status(404).json({ error: 'No pool found for this token' }); return; }
    allowed = creator.toLowerCase() === signer.toLowerCase();
  }
  if (!allowed) { res.status(403).json({ error: 'Only the pool creator can edit this token' }); return; }

  const sb = sbClient();
  const { error } = await sb.from('pool_tokens').upsert({
    token_address: tokenAddress.toLowerCase(),
    ...clean,
    updated_by: signer.toLowerCase(),
    updated_at: new Date().toISOString()
  }, { onConflict: 'token_address' });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(200).json({ ok: true });
}
