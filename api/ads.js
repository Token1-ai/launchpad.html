import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';

const V6 = typeof ethers.JsonRpcProvider === 'function';
const mkProvider = u => V6 ? new ethers.JsonRpcProvider(u) : new ethers.providers.JsonRpcProvider(u);
const mkIface = a => V6 ? new ethers.Interface(a) : new ethers.utils.Interface(a);
const fmtEther = v => V6 ? ethers.formatEther(v) : ethers.utils.formatEther(v);
const isAddr = a => V6 ? ethers.isAddress(a) : ethers.utils.isAddress(a);
const verifyMsg = (m, s) => V6 ? ethers.verifyMessage(m, s) : ethers.utils.verifyMessage(m, s);

const OWNER_WALLET = '0xC85b148F3EbD09e9072706166B4CD99cF7Ed3108';
const GOLD_PASS    = '0x4D26Ec2f8edbb3F567953CC7573FF60cA009258c';
const SILVER_PASS  = '0xeaDF62931f8ef2Ec546E77fBC5E56F1B3157Af89';
const USDT_ADDR    = '0x55d398326f99059fF775485246999027B3197955';
const USDC_ADDR    = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';

const RPCS = [
  'https://bnb-mainnet.g.alchemy.com/v2/9xLdJVjBnhaD8S0QJZcBA',
  'https://bsc-dataseed.binance.org/',
  'https://bsc-dataseed1.defibit.io/',
  'https://bsc-dataseed1.ninicoin.io/'
];

const TRANSFER_EVENT = ['event Transfer(address indexed from,address indexed to,uint256 value)'];
const PASS_ABI = ['function balanceOf(address) view returns (uint256)'];

const DEFAULT_PRICING = { gold_price_usd: 10, silver_price_usd: 15, public_price_usd: 25 };

// Максимум забронированного времени вперёд — считается от ТЕКУЩЕГО момента,
// а не за одну покупку. Продлевать можно только то, что уже прошло.
const MAX_AD_DAYS = 30;

const sbClient = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Иконки на баннере рисуются из этих ссылок. Пускаем только http/https,
// чтобы через javascript:/data: нельзя было протащить исполняемый код.
const safeUrl = s => { const v = String(s || '').trim().slice(0, 300); return /^https?:\/\//i.test(v) ? v : ''; };

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const body = req.body || {};
  try {
    if (body.action === 'submit')          return await doSubmit(body, res);
    if (body.action === 'extend')          return await doExtend(body, res);
    if (body.action === 'removeOwn')       return await doRemoveOwn(body, res);
    if (body.action === 'adminRemove')     return await doAdminRemove(body, res);
    if (body.action === 'adminSetPricing') return await doSetPricing(body, res);
    if (body.action === 'adminBlock')      return await doBlock(body, res);
    if (body.action === 'adminUnblock')    return await doUnblock(body, res);
    if (body.action === 'adminBlocked')    return await doListBlocked(body, res);
    if (body.action === 'adminPause')      return await doPause(body, res);
    if (body.action === 'editOwn')         return await doEditOwn(body, res);
    res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed' });
  }
}

/* ─── helpers ─── */

async function loadPricing() {
  try {
    const sb = sbClient();
    const { data } = await sb.from('ad_pricing').select('*').eq('id', 1).maybeSingle();
    if (data) {
      return {
        gold_price_usd:   Number(data.gold_price_usd)   > 0 ? Number(data.gold_price_usd)   : DEFAULT_PRICING.gold_price_usd,
        silver_price_usd: Number(data.silver_price_usd) > 0 ? Number(data.silver_price_usd) : DEFAULT_PRICING.silver_price_usd,
        public_price_usd: Number(data.public_price_usd) > 0 ? Number(data.public_price_usd) : DEFAULT_PRICING.public_price_usd,
        ads_paused: !!data.ads_paused
      };
    }
  } catch (e) {}
  return { ...DEFAULT_PRICING };
}

async function passBalance(passAddr, wallet) {
  for (const url of RPCS) {
    try {
      const c = new ethers.Contract(passAddr, PASS_ABI, mkProvider(url));
      const b = await c.balanceOf(wallet);
      return BigInt(b.toString());
    } catch (e) {}
  }
  return 0n;
}

async function getPricePerDay(wallet) {
  const pricing = await loadPricing();
  if (!wallet || !isAddr(wallet)) return pricing.public_price_usd;
  if (wallet.toLowerCase() === OWNER_WALLET.toLowerCase()) return 0;
  if (await passBalance(GOLD_PASS, wallet)   > 0n) return pricing.gold_price_usd;
  if (await passBalance(SILVER_PASS, wallet) > 0n) return pricing.silver_price_usd;
  return pricing.public_price_usd;
}

async function isBlocked(sb, wallet) {
  try {
    const { data } = await sb.from('ad_blocked').select('wallet').eq('wallet', String(wallet).toLowerCase()).maybeSingle();
    return !!data;
  } catch (e) { return false; }
}

async function adsArePaused() {
  const p = await loadPricing();
  return !!p.ads_paused;
}

function recoverSigner(message, signature) {
  if (!signature || typeof signature !== 'string') return null;
  try { return verifyMsg(message, signature); } catch (e) { return null; }
}

/* ─── submit (place an ad) ─── */

async function doSubmit(body, res) {
  const { slot, wallet, imageUrl, linkUrl, days, token, txHash, twitter, telegram, website, discord, youtube, tiktok } = body;
  if (![1, 2].includes(Number(slot))) { res.status(400).json({ error: 'Bad slot' }); return; }
  if (!wallet || !imageUrl || !days || !token || !txHash) { res.status(400).json({ error: 'Missing params' }); return; }
  if (!isAddr(wallet)) { res.status(400).json({ error: 'Bad wallet' }); return; }
  if (!/^https?:\/\//i.test(imageUrl)) { res.status(400).json({ error: 'Bad image URL' }); return; }

  // Основная ссылка не обязательна: рекламодателю может быть нужен только
  // Telegram, только Twitter или только страница своего токена.
  // Кликом по баннеру ведём на первую заполненную.
  const tw = safeUrl(twitter), tg = safeUrl(telegram), ws = safeUrl(website);
  const dc = safeUrl(discord), yt = safeUrl(youtube),  tk = safeUrl(tiktok);
  const target = safeUrl(linkUrl) || tw || tg || ws || dc || yt || tk;
  if (!target) { res.status(400).json({ error: 'Add at least one link' }); return; }
  const daysNum = Math.floor(Number(days));
  if (!(daysNum > 0 && daysNum <= MAX_AD_DAYS)) { res.status(400).json({ error: 'Max ' + MAX_AD_DAYS + ' days' }); return; }
  if (!['USDT', 'USDC'].includes(token)) { res.status(400).json({ error: 'Bad token' }); return; }
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) { res.status(400).json({ error: 'Bad tx hash' }); return; }

  const sb = sbClient();

  if (await adsArePaused()) { res.status(403).json({ error: 'Ad sales are temporarily paused by the platform' }); return; }
  if (await isBlocked(sb, wallet)) { res.status(403).json({ error: 'This wallet is not allowed to place ads' }); return; }

  const { data: existingTx } = await sb.from('ad_boards').select('id').eq('tx_hash', txHash).maybeSingle();
  if (existingTx) { res.status(409).json({ error: 'Transaction already used' }); return; }

  const { data: usedTx0 } = await sb.from('ad_tx_used').select('tx_hash').eq('tx_hash', txHash).maybeSingle();
  if (usedTx0) { res.status(409).json({ error: 'Transaction already used' }); return; }

  const nowIso = new Date().toISOString();
  const { data: busy } = await sb.from('ad_boards').select('id')
    .eq('slot', Number(slot)).eq('removed', false).gt('end_at', nowIso).maybeSingle();
  if (busy) { res.status(409).json({ error: 'Slot already occupied' }); return; }

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
  const requiredMin = perDay * daysNum * 0.999;
  const paidUsd = Number(fmtEther(value));
  if (paidUsd < requiredMin) { res.status(400).json({ error: 'Payment amount too low for ' + daysNum + ' day(s)' }); return; }

  const endAt = new Date(Date.now() + daysNum * 86400000).toISOString();

  const { data: newId, error } = await sb.rpc('place_ad_atomic', {
    p_slot: Number(slot),
    p_wallet: wallet.toLowerCase(),
    p_image_url: String(imageUrl).slice(0, 300),
    p_link_url: target,
    p_tx_hash: txHash,
    p_paid_amount: paidUsd,
    p_paid_token: token,
    p_days: daysNum,
    p_end_at: endAt
  });
  if (error) {
    const m = String(error.message || '');
    if (m.includes('slot_occupied')) { res.status(409).json({ error: 'Slot already occupied' }); return; }
    if (m.includes('tx_used'))       { res.status(409).json({ error: 'Transaction already used' }); return; }
    res.status(500).json({ error: error.message }); return;
  }

  // Ссылки для иконок пишем отдельным апдейтом: на защиту от гонки за слот
  // они не влияют, и так не приходится менять сигнатуру place_ad_atomic.
  if (newId && (tw || tg || ws || dc || yt || tk)) {
    try {
      await sb.from('ad_boards').update({
        twitter: tw, telegram: tg, website: ws,
        discord: dc, youtube: yt, tiktok: tk
      }).eq('id', newId);
    } catch (e) {}
  }

  res.status(200).json({ ok: true, id: newId });
}

/* ─── extend (продление своего объявления) ─── */

async function doExtend(body, res) {
  const { adId, wallet, days, token, txHash } = body;
  const id = Math.floor(Number(adId));
  if (!(id > 0)) { res.status(400).json({ error: 'Bad ad id' }); return; }
  if (!wallet || !isAddr(wallet)) { res.status(400).json({ error: 'Bad wallet' }); return; }
  const daysNum = Math.floor(Number(days));
  if (!(daysNum > 0 && daysNum <= MAX_AD_DAYS)) { res.status(400).json({ error: 'Max ' + MAX_AD_DAYS + ' days' }); return; }
  if (!['USDT', 'USDC'].includes(token)) { res.status(400).json({ error: 'Bad token' }); return; }
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) { res.status(400).json({ error: 'Bad tx hash' }); return; }

  const sb = sbClient();

  if (await adsArePaused()) { res.status(403).json({ error: 'Ad sales are temporarily paused by the platform' }); return; }
  if (await isBlocked(sb, wallet)) { res.status(403).json({ error: 'This wallet is not allowed to place ads' }); return; }

  // объявление должно существовать, быть живым и принадлежать плательщику
  const { data: ad } = await sb.from('ad_boards').select('id,wallet,removed,end_at').eq('id', id).maybeSingle();
  if (!ad) { res.status(404).json({ error: 'Ad not found' }); return; }
  if (ad.removed) { res.status(400).json({ error: 'Ad already removed' }); return; }
  if (String(ad.wallet).toLowerCase() !== wallet.toLowerCase()) { res.status(403).json({ error: 'Not your ad' }); return; }

  const endMs = new Date(ad.end_at).getTime();
  if (endMs <= Date.now()) { res.status(400).json({ error: 'Ad already expired — place a new one' }); return; }

  // предварительная проверка окна: платить бессмысленно, если продление не влезет
  if (endMs + daysNum * 86400000 > Date.now() + MAX_AD_DAYS * 86400000) {
    res.status(400).json({ error: 'Cannot book more than ' + MAX_AD_DAYS + ' days ahead' }); return;
  }

  // тот же txHash нельзя зачесть дважды
  const { data: usedTx } = await sb.from('ad_tx_used').select('tx_hash').eq('tx_hash', txHash).maybeSingle();
  if (usedTx) { res.status(409).json({ error: 'Transaction already used' }); return; }

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

  // цена берётся ТЕКУЩАЯ, на момент продления
  const perDay = await getPricePerDay(wallet);
  const requiredMin = perDay * daysNum * 0.999;
  const paidUsd = Number(fmtEther(value));
  if (paidUsd < requiredMin) { res.status(400).json({ error: 'Payment amount too low for ' + daysNum + ' day(s)' }); return; }

  const { data: newEnd, error } = await sb.rpc('extend_ad_atomic', {
    p_ad_id: id,
    p_wallet: wallet.toLowerCase(),
    p_tx_hash: txHash,
    p_paid_amount: paidUsd,
    p_paid_token: token,
    p_days: daysNum,
    p_max_days: MAX_AD_DAYS
  });
  if (error) {
    const m = String(error.message || '');
    if (m.includes('tx_used'))            { res.status(409).json({ error: 'Transaction already used' }); return; }
    if (m.includes('not_owner'))          { res.status(403).json({ error: 'Not your ad' }); return; }
    if (m.includes('ad_removed'))         { res.status(400).json({ error: 'Ad already removed' }); return; }
    if (m.includes('ad_expired'))         { res.status(400).json({ error: 'Ad already expired' }); return; }
    if (m.includes('exceeds_max_window')) { res.status(400).json({ error: 'Cannot book more than ' + MAX_AD_DAYS + ' days ahead' }); return; }
    res.status(500).json({ error: error.message }); return;
  }
  res.status(200).json({ ok: true, endAt: newEnd });
}

/* ─── advertiser removes their own ad ─── */

async function doRemoveOwn(body, res) {
  const { adId, signature } = body;
  const id = Math.floor(Number(adId));
  if (!(id > 0)) { res.status(400).json({ error: 'Bad ad id' }); return; }

  const signer = recoverSigner('Remove my OpenGate ad #' + id, signature);
  if (!signer) { res.status(400).json({ error: 'Bad signature' }); return; }

  const sb = sbClient();
  const { data: ad } = await sb.from('ad_boards').select('id,wallet,removed').eq('id', id).maybeSingle();
  if (!ad) { res.status(404).json({ error: 'Ad not found' }); return; }
  if (String(ad.wallet).toLowerCase() !== signer.toLowerCase()) { res.status(403).json({ error: 'Not your ad' }); return; }
  if (ad.removed) { res.status(200).json({ ok: true, alreadyRemoved: true }); return; }

  const { error } = await sb.from('ad_boards').update({ removed: true }).eq('id', id);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(200).json({ ok: true });
}

/* ─── owner removes any ad ─── */

async function doAdminRemove(body, res) {
  const { adId, signature } = body;
  const id = Math.floor(Number(adId));
  if (!(id > 0)) { res.status(400).json({ error: 'Bad ad id' }); return; }

  const signer = recoverSigner('OpenGate admin remove ad #' + id, signature);
  if (!signer || signer.toLowerCase() !== OWNER_WALLET.toLowerCase()) { res.status(403).json({ error: 'Owner only' }); return; }

  const sb = sbClient();
  const { data: ad } = await sb.from('ad_boards').select('id,removed').eq('id', id).maybeSingle();
  if (!ad) { res.status(404).json({ error: 'Ad not found' }); return; }
  if (ad.removed) { res.status(200).json({ ok: true, alreadyRemoved: true }); return; }

  const { error } = await sb.from('ad_boards').update({ removed: true }).eq('id', id);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(200).json({ ok: true });
}

/* ─── owner updates ad pricing ─── */

async function doSetPricing(body, res) {
  const { goldPrice, silverPrice, publicPrice, signature } = body;
  const g = Number(goldPrice), s = Number(silverPrice), p = Number(publicPrice);
  if (!(g > 0 && s > 0 && p > 0)) { res.status(400).json({ error: 'Bad prices' }); return; }
  if (!(g <= 100000 && s <= 100000 && p <= 100000)) { res.status(400).json({ error: 'Price too high' }); return; }

  const signer = recoverSigner('OpenGate admin set pricing ' + g + ',' + s + ',' + p, signature);
  if (!signer || signer.toLowerCase() !== OWNER_WALLET.toLowerCase()) { res.status(403).json({ error: 'Owner only' }); return; }

  const sb = sbClient();
  const { error } = await sb.from('ad_pricing').upsert({
    id: 1,
    gold_price_usd: g,
    silver_price_usd: s,
    public_price_usd: p
  }, { onConflict: 'id' });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(200).json({ ok: true });
}

/* ─── чёрный список рекламодателей (только владелец) ─── */

// Метка времени в подписи: перехваченную подпись нельзя применить позже,
// иначе можно было бы повторно разблокировать кого-то через сутки.
function adminAuth(action, target, ts, signature) {
  const tsNum = Number(ts);
  if (!isFinite(tsNum) || Math.abs(Date.now() - tsNum) > 10 * 60 * 1000) return { err: 'Signature expired — try again' };
  const signer = recoverSigner('OpenGate admin ' + action + ' ' + String(target).toLowerCase() + ' ' + tsNum, signature);
  if (!signer || signer.toLowerCase() !== OWNER_WALLET.toLowerCase()) return { err: 'Owner only' };
  return { signer };
}

async function doBlock(body, res) {
  const { wallet, reason, ts, signature } = body;
  if (!wallet || !isAddr(wallet)) { res.status(400).json({ error: 'Bad wallet' }); return; }
  if (wallet.toLowerCase() === OWNER_WALLET.toLowerCase()) { res.status(400).json({ error: 'Cannot block the owner wallet' }); return; }

  const auth = adminAuth('block', wallet, ts, signature);
  if (auth.err) { res.status(403).json({ error: auth.err }); return; }

  const sb = sbClient();
  const { error } = await sb.from('ad_blocked').upsert({
    wallet: wallet.toLowerCase(),
    reason: String(reason || '').slice(0, 200),
    blocked_by: auth.signer.toLowerCase(),
    blocked_at: new Date().toISOString()
  }, { onConflict: 'wallet' });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(200).json({ ok: true });
}

async function doUnblock(body, res) {
  const { wallet, ts, signature } = body;
  if (!wallet || !isAddr(wallet)) { res.status(400).json({ error: 'Bad wallet' }); return; }

  const auth = adminAuth('unblock', wallet, ts, signature);
  if (auth.err) { res.status(403).json({ error: auth.err }); return; }

  const sb = sbClient();
  const { error } = await sb.from('ad_blocked').delete().eq('wallet', wallet.toLowerCase());
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(200).json({ ok: true });
}

async function doListBlocked(body, res) {
  const { ts, signature } = body;
  const auth = adminAuth('list blocked', 'all', ts, signature);
  if (auth.err) { res.status(403).json({ error: auth.err }); return; }

  const sb = sbClient();
  const { data, error } = await sb.from('ad_blocked').select('wallet,reason,blocked_at').order('blocked_at', { ascending: false }).limit(200);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(200).json({ ok: true, blocked: data || [] });
}

/* ─── пауза продажи рекламы (только владелец) ─── */

async function doPause(body, res) {
  const { paused, ts, signature } = body;
  const want = !!paused;
  const auth = adminAuth('pause ads', want ? 'on' : 'off', ts, signature);
  if (auth.err) { res.status(403).json({ error: auth.err }); return; }

  const sb = sbClient();
  const { error } = await sb.from('ad_pricing').update({ ads_paused: want }).eq('id', 1);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(200).json({ ok: true, paused: want });
}

/* ─── рекламодатель правит своё объявление, пока оно оплачено ─── */

// Подпись покрывает всё содержимое: подменить картинку или ссылку
// под чужой подписью нельзя.
function adEditMessage(adId, m, ts) {
  return 'OpenGate ad edit\n' +
    'id: '    + adId + '\n' +
    'image: ' + (m.image_url || '') + '\n' +
    'link: '  + (m.link_url  || '') + '\n' +
    'x: '     + (m.twitter   || '') + '\n' +
    'tg: '    + (m.telegram  || '') + '\n' +
    'web: '   + (m.website   || '') + '\n' +
    'dc: '    + (m.discord   || '') + '\n' +
    'yt: '    + (m.youtube   || '') + '\n' +
    'tk: '    + (m.tiktok    || '') + '\n' +
    'ts: '    + ts;
}

async function doEditOwn(body, res) {
  const { adId, ts, signature, meta } = body;
  const id = Math.floor(Number(adId));
  if (!(id > 0) || !meta || !signature) { res.status(400).json({ error: 'Missing params' }); return; }

  const tsNum = Number(ts);
  if (!isFinite(tsNum) || Math.abs(Date.now() - tsNum) > 10 * 60 * 1000) {
    res.status(400).json({ error: 'Signature expired — try again' }); return;
  }

  const clean = {
    image_url: safeUrl(meta.image_url),
    link_url:  safeUrl(meta.link_url),
    twitter:   safeUrl(meta.twitter),
    telegram:  safeUrl(meta.telegram),
    website:   safeUrl(meta.website),
    discord:   safeUrl(meta.discord),
    youtube:   safeUrl(meta.youtube),
    tiktok:    safeUrl(meta.tiktok)
  };
  if (!clean.image_url) { res.status(400).json({ error: 'Banner image is required' }); return; }

  const target = clean.link_url || clean.twitter || clean.telegram || clean.website || clean.discord || clean.youtube || clean.tiktok;
  if (!target) { res.status(400).json({ error: 'Add at least one link' }); return; }
  clean.link_url = target;

  const signer = recoverSigner(adEditMessage(id, clean, tsNum), signature);
  if (!signer) { res.status(400).json({ error: 'Bad signature' }); return; }

  const sb = sbClient();
  const { data: ad } = await sb.from('ad_boards').select('id,wallet,removed,end_at').eq('id', id).maybeSingle();
  if (!ad) { res.status(404).json({ error: 'Ad not found' }); return; }
  if (ad.removed) { res.status(400).json({ error: 'Ad already removed' }); return; }
  if (new Date(ad.end_at).getTime() <= Date.now()) { res.status(400).json({ error: 'Ad already expired' }); return; }

  // Владелец площадки тоже может править — например, чтобы убрать
  // неприемлемую картинку, не удаляя оплаченное объявление целиком.
  const isOwner = signer.toLowerCase() === OWNER_WALLET.toLowerCase();
  if (String(ad.wallet).toLowerCase() !== signer.toLowerCase() && !isOwner) {
    res.status(403).json({ error: 'Not your ad' }); return;
  }

  const { error } = await sb.from('ad_boards').update(clean).eq('id', id);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(200).json({ ok: true });
}
