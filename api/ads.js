import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';

const V6 = typeof ethers.JsonRpcProvider === 'function';
const mkProvider = u => V6 ? new ethers.JsonRpcProvider(u) : new ethers.providers.JsonRpcProvider(u);
const mkIface = a => V6 ? new ethers.Interface(a) : new ethers.utils.Interface(a);
const fmtEther = v => V6 ? ethers.formatEther(v) : ethers.utils.formatEther(v);
const verifyMsg = (msg, sig) => V6 ? ethers.verifyMessage(msg, sig) : ethers.utils.verifyMessage(msg, sig);

const OWNER_WALLET = '0xC85b148F3EbD09e9072706166B4CD99cF7Ed3108';
const GOLD_PASS = '0x4D26Ec2f8edbb3F567953CC7573FF60cA009258c';
const SILVER_PASS = '0xeaDF62931f8ef2Ec546E77fBC5E56F1B3157Af89';
const USDT_ADDR = '0x55d398326f99059fF775485246999027B3197955';
const USDC_ADDR = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';
const RPCS = [
  'https://bnb-mainnet.g.alchemy.com/v2/9xLdJVjBnhaD8S0QJZcBA',
  'https://bsc-dataseed.binance.org/'
];
const TRANSFER_EVENT = ['event Transfer(address indexed from,address indexed to,uint256 value)'];
const PASS_ABI = ['function balanceOf(address) view returns (uint256)'];

const sbClient = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const body = req.body || {};
  try {
    if (body.action === 'submit') return await doSubmit(body, res);
    if (body.action === 'removeOwn') return await doRemove(body, res, false);
    if (body.action === 'adminRemove') return await doRemove(body, res, true);
    if (body.action === 'adminSetPricing') return await doSetPricing(body, res);
    res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed' });
  }
}

async function getPricePerDay(wallet) {
  const sb = sbClient();
  const { data: pricing } = await sb.from('ad_pricing').select('*').eq('id', 1).maybeSingle();
  const p = pricing || { gold_price_usd: 10, silver_price_usd: 15, public_price_usd: 25 };
  for (const url of RPCS) {
    try {
      const provider = mkProvider(url);
      const gp = new ethers.Contract(GOLD_PASS, PASS_ABI, provider);
      if ((await gp.balanceOf(wallet)) > 0n) return p.gold_price_usd;
      const sp = new ethers.Contract(SILVER_PASS, PASS_ABI, provider);
      if ((await sp.balanceOf(wallet)) > 0n) return p.silver_price_usd;
      return p.public_price_usd;
    } catch (e) {}
  }
  return p.public_price_usd;
}

async function doSubmit(body, res) {
  const { slot, wallet, imageUrl, linkUrl, days, token, txHash } = body;
  if (![1, 2].includes(Number(slot))) { res.status(400).json({ error: 'Bad slot' }); return; }
  if (!wallet || !imageUrl || !linkUrl || !days || !token || !txHash) { res.status(400).json({ error: 'Missing params' }); return; }
  if (!/^https?:\/\//i.test(linkUrl)) { res.status(400).json({ error: 'Bad link URL' }); return; }
  const daysNum = Math.floor(Number(days));
  if (!(daysNum > 0 && daysNum <= 365)) { res.status(400).json({ error: 'Bad days' }); return; }
  if (!['USDT', 'USDC'].includes(token)) { res.status(400).json({ error: 'Bad token' }); return; }
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) { res.status(400).json({ error: 'Bad tx hash' }); return; }

  const sb = sbClient();

  const nowIso = new Date().toISOString();
  const { data: occupied } = await sb.from('ad_boards').select('id').eq('slot', slot).eq('removed', false).gt('end_at', nowIso).maybeSingle();
  if (occupied) { res.status(409).json({ error: 'Slot already occupied' }); return; }

  const { data: existingTx } = await sb.from('ad_boards').select('id').eq('tx_hash', txHash).maybeSingle();
  if (existingTx) { res.status(409).json({ error: 'Transaction already used' }); return; }

  const tokenAddr = token === 'USDT' ? USDT_ADDR : USDC_ADDR;

  let receipt = null;
  for (const url of RPCS) {
    try { receipt = await mkProvider(url).getTransactionReceipt(txHash); if (receipt) break; } catch (e) {}
  }
  if (!receipt) { res.status(404).json({ error: 'Tx not found' }); return; }
  if (Number(receipt.status) !== 1) { res.status(400).json({ error: 'Tx failed' }); return; }

  const iface = mkIface(TRANSFER_EVENT);
  let value = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== tokenAddr.toLowerCase()) continue;
    let p; try { p = iface.parseLog(log); } catch (e) { continue; }
    if (!p || p.name !== 'Transfer') continue;
    if (String(p.args.from).toLowerCase() !== wallet.toLowerCase()) continue;
    if (String(p.args.to).toLowerCase() !== OWNER_WALLET.toLowerCase()) continue;
    value = p.args.value;
    break;
  }
  if (value === null) { res.status(400).json({ error: 'No matching payment found' }); return; }

  const perDay = await getPricePerDay(wallet);
  const requiredMin = perDay * daysNum * 0.999; // небольшой допуск на округление
  const paidUsd = Number(fmtEther(value));
  if (paidUsd < requiredMin) { res.status(400).json({ error: 'Payment amount too low for ' + daysNum + ' day(s)' }); return; }

  const endAt = new Date(Date.now() + daysNum * 86400000).toISOString();
  const { error } = await sb.from('ad_boards').insert({
    slot: Number(slot),
    wallet: wallet.toLowerCase(),
    image_url: String(imageUrl).slice(0, 300),
    link_url: String(linkUrl).slice(0, 300),
    tx_hash: txHash,
    paid_amount: paidUsd,
    paid_token: token,
    days: daysNum,
    end_at: endAt
  });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(200).json({ ok: true });
}

async function doRemove(body, res, isAdmin) {
  const { adId, wallet, signature } = body;
  if (!adId || !wallet || !signature) { res.status(400).json({ error: 'Missing params' }); return; }

  const sb = sbClient();
  const { data: ad } = await sb.from('ad_boards').select('*').eq('id', adId).maybeSingle();
  if (!ad) { res.status(404).json({ error: 'Ad not found' }); return; }

  const message = isAdmin ? ('OpenGate admin remove ad #' + adId) : ('Remove my OpenGate ad #' + adId);
  let recovered;
  try { recovered = verifyMsg(message, signature); } catch (e) { res.status(400).json({ error: 'Bad signature' }); return; }

  if (isAdmin) {
    if (recovered.toLowerCase() !== OWNER_WALLET.toLowerCase()) { res.status(403).json({ error: 'Not owner' }); return; }
  } else {
    if (recovered.toLowerCase() !== wallet.toLowerCase() || wallet.toLowerCase() !== ad.wallet.toLowerCase()) { res.status(403).json({ error: 'Not your ad' }); return; }
  }

  const { error } = await sb.from('ad_boards').update({ removed: true }).eq('id', adId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(200).json({ ok: true });
}

async function doSetPricing(body, res) {
  const { goldPrice, silverPrice, publicPrice, signature } = body;
  if (!(goldPrice > 0 && silverPrice > 0 && publicPrice > 0) || !signature) { res.status(400).json({ error: 'Bad params' }); return; }

  const message = 'OpenGate admin set pricing ' + goldPrice + ',' + silverPrice + ',' + publicPrice;
  let recovered;
  try { recovered = verifyMsg(message, signature); } catch (e) { res.status(400).json({ error: 'Bad signature' }); return; }
  if (recovered.toLowerCase() !== OWNER_WALLET.toLowerCase()) { res.status(403).json({ error: 'Not owner' }); return; }

  const sb = sbClient();
  const { error } = await sb.from('ad_pricing').update({
    gold_price_usd: Number(goldPrice), silver_price_usd: Number(silverPrice), public_price_usd: Number(publicPrice), updated_at: new Date().toISOString()
  }).eq('id', 1);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(200).json({ ok: true });
}
