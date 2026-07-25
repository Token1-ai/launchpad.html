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

const sbClient = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const body = req.body || {};
  try {
    if (body.action === 'trade') return await doTrade(body, res);
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
