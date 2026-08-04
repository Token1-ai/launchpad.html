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
// Адрес токена показывается на баннере, чтобы его можно было скопировать.
// Пускаем только настоящий вид адреса — иначе туда впишут что угодно.
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const safeTokenAddr = s => { const v = String(s || '').trim(); return /^0x[0-9a-fA-F]{40}$/.test(v) ? v : ''; };

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const body = req.body || {};
  try {
    if (body.action === 'submit')          return await doSubmit(body, res);
    if (body.action === 'extend')          return await doExtend(body, res);
    if (body.action === 'removeOwn')       return await doRemoveOwn(body, res);
    if (body.action === 'adminRemove')     return await doAdminRemove(body, res);
    if (body.action === 'adminSetPricing') return await doSetPricing(body, res);
    if (body.action === 'adminGrant')      return await doAdminGrant(body, res);
    if (body.action === 'adminGrantFeat')  return await doAdminGrantFeat(body, res);
    if (body.action === 'adminPromoNew')   return await doPromoNew(body, res);
    if (body.action === 'adminPromoList')  return await doPromoList(body, res);
    if (body.action === 'adminPromoStop')  return await doPromoStop(body, res);
    if (body.action === 'promoCheck')      return await doPromoCheck(body, res);
    if (body.action === 'submitFree')      return await doSubmitFree(body, res);
    if (body.action === 'featSubmitFree')  return await doFeatSubmitFree(body, res);
    if (body.action === 'adminBlock')      return await doBlock(body, res);
    if (body.action === 'adminUnblock')    return await doUnblock(body, res);
    if (body.action === 'adminBlocked')    return await doListBlocked(body, res);
    if (body.action === 'adminPause')      return await doPause(body, res);
    if (body.action === 'editOwn')         return await doEditOwn(body, res);
    if (body.action === 'featSubmit')      return await doFeatSubmit(body, res);
    if (body.action === 'featExtend')      return await doFeatExtend(body, res);
    if (body.action === 'featRemove')      return await doFeatRemove(body, res);
    if (body.action === 'featPause')       return await doFeatPause(body, res);
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
        ads_paused: !!data.ads_paused,
        feat_gold_usd:   Number(data.feat_gold_usd)   > 0 ? Number(data.feat_gold_usd)   : 5,
        feat_silver_usd: Number(data.feat_silver_usd) > 0 ? Number(data.feat_silver_usd) : 8,
        feat_public_usd: Number(data.feat_public_usd) > 0 ? Number(data.feat_public_usd) : 12,
        feat_paused: !!data.feat_paused
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
  const { slot, wallet, imageUrl, linkUrl, days, token, txHash, twitter, telegram, website, discord, youtube, tiktok, tokenAddress, headline } = body;
  if (![1, 2].includes(Number(slot))) { res.status(400).json({ error: 'Bad slot' }); return; }
  if (!wallet || !imageUrl || !days || !token || !txHash) { res.status(400).json({ error: 'Missing params' }); return; }
  if (!isAddr(wallet)) { res.status(400).json({ error: 'Bad wallet' }); return; }
  if (!/^https?:\/\//i.test(imageUrl)) { res.status(400).json({ error: 'Bad image URL' }); return; }

  // Основная ссылка не обязательна: рекламодателю может быть нужен только
  // Telegram, только Twitter или только страница своего токена.
  // Кликом по баннеру ведём на первую заполненную.
  const tw = safeUrl(twitter), tg = safeUrl(telegram), ws = safeUrl(website);
  const dc = safeUrl(discord), yt = safeUrl(youtube),  tk = safeUrl(tiktok);
  const ca = safeTokenAddr(tokenAddress);
  const target = safeUrl(linkUrl) || tw || tg || ws || dc || yt || tk;
  // Адрес токена сам по себе годится: клик по баннеру откроет его график
  // прямо на сайте, внешняя ссылка при этом не нужна.
  if (!target && !ca) { res.status(400).json({ error: 'Add at least one link or a token address' }); return; }
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
  const head = clip(headline, 80);
  if (newId && (tw || tg || ws || dc || yt || tk || ca || head)) {
    try {
      await sb.from('ad_boards').update({
        twitter: tw, telegram: tg, website: ws,
        discord: dc, youtube: yt, tiktok: tk,
        token_address: ca, headline: head
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

/* ═══════════════ БЕСПЛАТНАЯ ВЫДАЧА ВЛАДЕЛЬЦЕМ ═══════════════
 *
 * Владелец может подарить баннер или место в верхнем ряду на выбранный срок.
 * Размещение идёт тем же путём, что и платное — через те же атомарные
 * функции базы, — поэтому проверки занятости слота и сроков работают
 * одинаково. Отличий ровно два: платёж в блокчейне не проверяется,
 * а сумма записывается нулём с пометкой GRANT.
 *
 * Зачем: раздавать первым создателям токенов места даром, чтобы привести
 * настоящих людей. Подарки всегда отличимы от платных в отчётах —
 * по нулевой сумме и по слову GRANT в поле валюты.
 */

// Метка вместо хеша транзакции: формат тот же (0x и 64 знака), поэтому
// проверки формата не спотыкаются, а по началу видно, что это подарок.
function grantMark() {
  let hex = '';
  while (hex.length < 56) hex += Math.floor(Math.random() * 16).toString(16);
  return '0x' + 'a11f' + Date.now().toString(16).padStart(12, '0') + hex.slice(0, 48);
}

async function doAdminGrant(body, res) {
  const { slot, wallet, imageUrl, linkUrl, days, signature,
          twitter, telegram, website, discord, youtube, tiktok, tokenAddress, headline } = body;

  if (![1, 2].includes(Number(slot))) { res.status(400).json({ error: 'Bad slot' }); return; }
  if (!wallet || !isAddr(wallet))     { res.status(400).json({ error: 'Bad wallet' }); return; }
  if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) { res.status(400).json({ error: 'Bad image URL' }); return; }

  const daysNum = Math.floor(Number(days));
  if (!(daysNum > 0 && daysNum <= MAX_AD_DAYS)) { res.status(400).json({ error: 'Max ' + MAX_AD_DAYS + ' days' }); return; }

  // Подпись покрывает получателя, слот и срок — подарок нельзя переиграть
  // на другой кошелёк или другой срок, перехватив запрос.
  const msg = 'OpenGate admin grant ad ' + Number(slot) + ' ' + wallet.toLowerCase() + ' ' + daysNum;
  const signer = recoverSigner(msg, signature);
  if (!signer || signer.toLowerCase() !== OWNER_WALLET.toLowerCase()) { res.status(403).json({ error: 'Owner only' }); return; }

  const tw = safeUrl(twitter), tg = safeUrl(telegram), ws = safeUrl(website);
  const dc = safeUrl(discord), yt = safeUrl(youtube),  tk = safeUrl(tiktok);
  const ca = safeTokenAddr(tokenAddress);
  const target = safeUrl(linkUrl) || tw || tg || ws || dc || yt || tk;
  if (!target && !ca) { res.status(400).json({ error: 'Add at least one link or a token address' }); return; }

  const sb = sbClient();
  const nowIso = new Date().toISOString();
  const { data: busy } = await sb.from('ad_boards').select('id')
    .eq('slot', Number(slot)).eq('removed', false).gt('end_at', nowIso).maybeSingle();
  if (busy) { res.status(409).json({ error: 'Slot already occupied' }); return; }

  const endAt = new Date(Date.now() + daysNum * 86400000).toISOString();

  const { data: newId, error } = await sb.rpc('place_ad_atomic', {
    p_slot: Number(slot),
    p_wallet: wallet.toLowerCase(),
    p_image_url: String(imageUrl).slice(0, 300),
    p_link_url: target,
    p_tx_hash: grantMark(),
    p_paid_amount: 0,
    p_paid_token: 'GRANT',
    p_days: daysNum,
    p_end_at: endAt
  });
  if (error) {
    const m = String(error.message || '');
    if (m.includes('slot_occupied')) { res.status(409).json({ error: 'Slot already occupied' }); return; }
    res.status(500).json({ error: m }); return;
  }

  const extra = {};
  if (tw) extra.twitter = tw;
  if (tg) extra.telegram = tg;
  if (ws) extra.website = ws;
  if (dc) extra.discord = dc;
  if (yt) extra.youtube = yt;
  if (tk) extra.tiktok = tk;
  if (ca) extra.token_address = ca;
  if (headline) extra.headline = String(headline).slice(0, 80);
  if (Object.keys(extra).length && newId) {
    await sb.from('ad_boards').update(extra).eq('id', newId);
  }

  res.status(200).json({ ok: true, id: newId, granted: true, days: daysNum, endAt });
}

async function doAdminGrantFeat(body, res) {
  const { slot, tokenAddress, pad, kind, poolId, wallet, days, signature } = body;

  if (!(Number(slot) >= 1 && Number(slot) <= 4)) { res.status(400).json({ error: 'Bad slot' }); return; }
  if (!wallet || !isAddr(wallet)) { res.status(400).json({ error: 'Bad wallet' }); return; }
  if (!tokenAddress || !isAddr(tokenAddress)) { res.status(400).json({ error: 'Bad token address' }); return; }
  if (!['launch', 'pool'].includes(String(kind))) { res.status(400).json({ error: 'Bad kind' }); return; }

  const daysNum = Math.floor(Number(days));
  if (!(daysNum > 0 && daysNum <= MAX_AD_DAYS)) { res.status(400).json({ error: 'Max ' + MAX_AD_DAYS + ' days' }); return; }

  const msg = 'OpenGate admin grant feat ' + Number(slot) + ' ' + String(tokenAddress).toLowerCase() + ' ' + daysNum;
  const signer = recoverSigner(msg, signature);
  if (!signer || signer.toLowerCase() !== OWNER_WALLET.toLowerCase()) { res.status(403).json({ error: 'Owner only' }); return; }

  const sb = sbClient();
  const endAt = new Date(Date.now() + daysNum * 86400000).toISOString();

  const { data: newId, error } = await sb.rpc('place_featured_atomic', {
    p_slot: Number(slot),
    p_token: String(tokenAddress).toLowerCase(),
    p_pad: pad || null,
    p_wallet: wallet.toLowerCase(),
    p_tx_hash: grantMark(),
    p_paid_amount: 0,
    p_paid_token: 'GRANT',
    p_days: daysNum,
    p_end_at: endAt,
    p_kind: String(kind),
    p_pool_id: poolId || null
  });
  if (error) {
    const m = String(error.message || '');
    if (m.includes('slot_occupied'))          { res.status(409).json({ error: 'Slot already taken' }); return; }
    if (m.includes('token_already_featured')) { res.status(409).json({ error: 'This token is already featured' }); return; }
    res.status(500).json({ error: m }); return;
  }

  res.status(200).json({ ok: true, id: newId, granted: true, days: daysNum, endAt });
}

/* ═══════════════ АКЦИИ «БЕСПЛАТНОЕ МЕСТО» ═══════════════
 *
 * Владелец объявляет акцию: сколько мест, на сколько дней и кому
 * (только Gold, только Silver или всем). Дальше места разбирают сами
 * пользователи — кто первый нажал, тот и получил.
 *
 * Одно место на кошелёк в рамках одной акции. Владелец Gold проходит
 * и по серебряной акции, но не наоборот.
 *
 * Гонка при одновременном нажатии решена в базе: уменьшение счётчика и
 * запись «кто взял» идут одной командой claim_promo_atomic, поэтому
 * двое не получат одно и то же место.
 */

// Тариф кошелька: нужен и для проверки доступа к акции, и для показа.
async function walletTier(wallet) {
  if (!wallet || !isAddr(wallet)) return { gold: false, silver: false };
  if (String(wallet).toLowerCase() === OWNER_WALLET.toLowerCase()) return { gold: true, silver: true };
  const gold   = (await passBalance(GOLD_PASS, wallet))   > 0n;
  const silver = (await passBalance(SILVER_PASS, wallet)) > 0n;
  return { gold, silver };
}

async function doPromoNew(body, res) {
  const { kind, tier, days, slots, expiresInDays, note, signature } = body;

  if (!['ad', 'feat'].includes(String(kind)))            { res.status(400).json({ error: 'Bad kind' }); return; }
  if (!['gold', 'silver', 'any'].includes(String(tier))) { res.status(400).json({ error: 'Bad tier' }); return; }

  const d = Math.floor(Number(days));
  const n = Math.floor(Number(slots));
  if (!(d > 0 && d <= MAX_AD_DAYS)) { res.status(400).json({ error: 'Days must be 1-' + MAX_AD_DAYS }); return; }
  if (!(n > 0 && n <= 1000))        { res.status(400).json({ error: 'Slots must be 1-1000' }); return; }

  const msg = 'OpenGate admin promo ' + kind + ' ' + tier + ' ' + d + ' ' + n;
  const signer = recoverSigner(msg, signature);
  if (!signer || signer.toLowerCase() !== OWNER_WALLET.toLowerCase()) { res.status(403).json({ error: 'Owner only' }); return; }

  const exp = Math.floor(Number(expiresInDays));
  const expiresAt = (exp > 0 && exp <= 365)
    ? new Date(Date.now() + exp * 86400000).toISOString()
    : null;

  const sb = sbClient();
  const { data, error } = await sb.from('ad_promos').insert({
    kind: String(kind), tier: String(tier), days: d,
    slots_total: n, slots_left: n, active: true,
    expires_at: expiresAt,
    note: note ? String(note).slice(0, 120) : null
  }).select('*').single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(200).json({ ok: true, promo: data });
}

async function doPromoList(body, res) {
  const signer = recoverSigner('OpenGate admin promo list', body.signature);
  if (!signer || signer.toLowerCase() !== OWNER_WALLET.toLowerCase()) { res.status(403).json({ error: 'Owner only' }); return; }
  const sb = sbClient();
  const { data, error } = await sb.from('ad_promos').select('*').order('created_at', { ascending: false }).limit(50);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(200).json({ ok: true, promos: data || [] });
}

async function doPromoStop(body, res) {
  const id = Math.floor(Number(body.promoId));
  if (!(id > 0)) { res.status(400).json({ error: 'Bad promo id' }); return; }
  const signer = recoverSigner('OpenGate admin promo stop ' + id, body.signature);
  if (!signer || signer.toLowerCase() !== OWNER_WALLET.toLowerCase()) { res.status(403).json({ error: 'Owner only' }); return; }
  const sb = sbClient();
  const { error } = await sb.from('ad_promos').update({ active: false }).eq('id', id);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(200).json({ ok: true });
}

// Показать пользователю, доступно ли ему бесплатное место. Ничего не
// расходует — только смотрит.
async function doPromoCheck(body, res) {
  const { kind, wallet } = body;
  if (!['ad', 'feat'].includes(String(kind))) { res.status(400).json({ error: 'Bad kind' }); return; }
  if (!wallet || !isAddr(wallet)) { res.status(200).json({ ok: true, available: false }); return; }

  const tier = await walletTier(wallet);
  const sb = sbClient();
  const { data, error } = await sb.rpc('promo_available', {
    p_kind: String(kind), p_wallet: String(wallet).toLowerCase(),
    p_gold: tier.gold, p_silver: tier.silver
  });
  if (error) { res.status(500).json({ error: error.message }); return; }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) { res.status(200).json({ ok: true, available: false, tier }); return; }
  res.status(200).json({ ok: true, available: true, days: row.promo_days, slotsLeft: row.slots_left, tier });
}

/**
 * Забрать бесплатное место. Порядок важен: сначала атомарно занимаем
 * место в акции, и только потом размещаем. Если размещение не удалось —
 * возвращаем место обратно, иначе оно сгорело бы впустую.
 */
async function claimPromoOrFail(sb, kind, wallet, res) {
  const tier = await walletTier(wallet);
  const { data, error } = await sb.rpc('claim_promo_atomic', {
    p_kind: kind, p_wallet: String(wallet).toLowerCase(),
    p_gold: tier.gold, p_silver: tier.silver
  });
  if (error) { res.status(500).json({ error: error.message }); return null; }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !row.promo_id) {
    res.status(409).json({ error: 'No free placement available for your wallet right now' });
    return null;
  }
  return { promoId: row.promo_id, days: row.promo_days };
}

async function releasePromo(sb, promoId, wallet) {
  try {
    await sb.from('ad_promo_claims').delete().eq('promo_id', promoId).eq('wallet', String(wallet).toLowerCase());
    const { data } = await sb.from('ad_promos').select('slots_left,slots_total').eq('id', promoId).maybeSingle();
    if (data) {
      await sb.from('ad_promos')
        .update({ slots_left: Math.min(Number(data.slots_left) + 1, Number(data.slots_total)), active: true })
        .eq('id', promoId);
    }
  } catch (e) { /* место вернуть не удалось — не роняем ответ пользователю */ }
}

/**
 * Пользователь забирает бесплатное место (баннер). Отличия от платного
 * размещения: вместо проверки платежа в блокчейне — проверка акции.
 * Всё остальное — занятость слота, чёрный список, пауза продаж, ссылки —
 * проверяется ровно так же.
 */
async function doSubmitFree(body, res) {
  const { slot, wallet, imageUrl, linkUrl, signature,
          twitter, telegram, website, discord, youtube, tiktok, tokenAddress, headline } = body;

  if (![1, 2].includes(Number(slot))) { res.status(400).json({ error: 'Bad slot' }); return; }
  if (!wallet || !isAddr(wallet))     { res.status(400).json({ error: 'Bad wallet' }); return; }
  if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) { res.status(400).json({ error: 'Bad image URL' }); return; }

  // Подпись владельца кошелька: чтобы место нельзя было забрать за чужой счёт
  const signer = recoverSigner('OpenGate claim free ad ' + Number(slot) + ' ' + String(wallet).toLowerCase(), signature);
  if (!signer || signer.toLowerCase() !== String(wallet).toLowerCase()) { res.status(403).json({ error: 'Signature does not match wallet' }); return; }

  const tw = safeUrl(twitter), tg = safeUrl(telegram), ws = safeUrl(website);
  const dc = safeUrl(discord), yt = safeUrl(youtube),  tk = safeUrl(tiktok);
  const ca = safeTokenAddr(tokenAddress);
  const target = safeUrl(linkUrl) || tw || tg || ws || dc || yt || tk;
  if (!target && !ca) { res.status(400).json({ error: 'Add at least one link or a token address' }); return; }

  const sb = sbClient();
  if (await adsArePaused())        { res.status(403).json({ error: 'Ad sales are temporarily paused' }); return; }
  if (await isBlocked(sb, wallet)) { res.status(403).json({ error: 'This wallet is not allowed to place ads' }); return; }

  const nowIso = new Date().toISOString();
  const { data: busy } = await sb.from('ad_boards').select('id')
    .eq('slot', Number(slot)).eq('removed', false).gt('end_at', nowIso).maybeSingle();
  if (busy) { res.status(409).json({ error: 'Slot already occupied' }); return; }

  const claim = await claimPromoOrFail(sb, 'ad', wallet, res);
  if (!claim) return;

  const endAt = new Date(Date.now() + claim.days * 86400000).toISOString();
  const { data: newId, error } = await sb.rpc('place_ad_atomic', {
    p_slot: Number(slot), p_wallet: String(wallet).toLowerCase(),
    p_image_url: String(imageUrl).slice(0, 300), p_link_url: target,
    p_tx_hash: grantMark(), p_paid_amount: 0, p_paid_token: 'PROMO',
    p_days: claim.days, p_end_at: endAt
  });
  if (error) {
    await releasePromo(sb, claim.promoId, wallet);   // место не сгорает зря
    const m = String(error.message || '');
    if (m.includes('slot_occupied')) { res.status(409).json({ error: 'Slot already occupied' }); return; }
    res.status(500).json({ error: m }); return;
  }

  const extra = {};
  if (tw) extra.twitter = tw;
  if (tg) extra.telegram = tg;
  if (ws) extra.website = ws;
  if (dc) extra.discord = dc;
  if (yt) extra.youtube = yt;
  if (tk) extra.tiktok = tk;
  if (ca) extra.token_address = ca;
  if (headline) extra.headline = String(headline).slice(0, 80);
  if (Object.keys(extra).length && newId) await sb.from('ad_boards').update(extra).eq('id', newId);

  res.status(200).json({ ok: true, id: newId, free: true, days: claim.days, endAt });
}

/** То же самое для места в верхнем ряду. */
async function doFeatSubmitFree(body, res) {
  const { slot, tokenAddress, pad, kind, poolId, wallet, signature } = body;

  if (!(Number(slot) >= 1 && Number(slot) <= 4))   { res.status(400).json({ error: 'Bad slot' }); return; }
  if (!wallet || !isAddr(wallet))                  { res.status(400).json({ error: 'Bad wallet' }); return; }
  if (!tokenAddress || !isAddr(tokenAddress))      { res.status(400).json({ error: 'Bad token address' }); return; }
  if (!['launch', 'pool'].includes(String(kind)))  { res.status(400).json({ error: 'Bad kind' }); return; }

  const signer = recoverSigner('OpenGate claim free feat ' + Number(slot) + ' ' + String(tokenAddress).toLowerCase(), signature);
  if (!signer || signer.toLowerCase() !== String(wallet).toLowerCase()) { res.status(403).json({ error: 'Signature does not match wallet' }); return; }

  const sb = sbClient();
  if (await isBlocked(sb, wallet)) { res.status(403).json({ error: 'This wallet is not allowed' }); return; }

  const claim = await claimPromoOrFail(sb, 'feat', wallet, res);
  if (!claim) return;

  const endAt = new Date(Date.now() + claim.days * 86400000).toISOString();
  const { data: newId, error } = await sb.rpc('place_featured_atomic', {
    p_slot: Number(slot), p_token: String(tokenAddress).toLowerCase(),
    p_pad: pad || null, p_wallet: String(wallet).toLowerCase(),
    p_tx_hash: grantMark(), p_paid_amount: 0, p_paid_token: 'PROMO',
    p_days: claim.days, p_end_at: endAt, p_kind: String(kind), p_pool_id: poolId || null
  });
  if (error) {
    await releasePromo(sb, claim.promoId, wallet);
    const m = String(error.message || '');
    if (m.includes('slot_occupied'))          { res.status(409).json({ error: 'Slot already taken' }); return; }
    if (m.includes('token_already_featured')) { res.status(409).json({ error: 'This token is already featured' }); return; }
    res.status(500).json({ error: m }); return;
  }

  res.status(200).json({ ok: true, id: newId, free: true, days: claim.days, endAt });
}

async function doSetPricing(body, res) {
  const { goldPrice, silverPrice, publicPrice, featGold, featSilver, featPublic, signature } = body;
  const g = Number(goldPrice), s = Number(silverPrice), p = Number(publicPrice);
  if (!(g > 0 && s > 0 && p > 0)) { res.status(400).json({ error: 'Bad prices' }); return; }
  if (!(g <= 100000 && s <= 100000 && p <= 100000)) { res.status(400).json({ error: 'Price too high' }); return; }

  const signer = recoverSigner('OpenGate admin set pricing ' + g + ',' + s + ',' + p, signature);
  if (!signer || signer.toLowerCase() !== OWNER_WALLET.toLowerCase()) { res.status(403).json({ error: 'Owner only' }); return; }

  const sb = sbClient();
  // Цены мест в верхнем ряду сохраняются той же подписью:
  // подпись покрывает рекламные цены, а места — отдельные колонки.
  const row = { id: 1, gold_price_usd: g, silver_price_usd: s, public_price_usd: p };
  const fg = Number(featGold), fs = Number(featSilver), fp = Number(featPublic);
  if (fg > 0 && fg <= 100000) row.feat_gold_usd = fg;
  if (fs > 0 && fs <= 100000) row.feat_silver_usd = fs;
  if (fp > 0 && fp <= 100000) row.feat_public_usd = fp;

  const { error } = await sb.from('ad_pricing').upsert(row, { onConflict: 'id' });
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
    'ca: '    + (m.token_address || '') + '\n' +
    'txt: '   + (m.headline || '') + '\n' +
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
    tiktok:    safeUrl(meta.tiktok),
    token_address: safeTokenAddr(meta.token_address),
    headline:      clip(meta.headline, 80)
  };
  if (!clean.image_url) { res.status(400).json({ error: 'Banner image is required' }); return; }

  const target = clean.link_url || clean.twitter || clean.telegram || clean.website || clean.discord || clean.youtube || clean.tiktok;
  if (!target && !clean.token_address) { res.status(400).json({ error: 'Add at least one link or a token address' }); return; }
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

/* ═══════════ ВЕРХНИЙ РЯД ТОКЕНОВ (FEATURED) ═══════════ */

const LAUNCHPAD_V1_ADDR = '0xFf06CfB755f5d08eB0A60fC6fA56dc525DbAca0d';
const LAUNCHPAD_V2_ADDR = '0x672F6a4a78a1650617BFc5FA5E6B1428A594E5FE';
const CURVE_READ_ABI = [
  'function getCurve(address) view returns (address creator,uint256 realBNB,uint256 tokensSold,bool graduated,uint256 createdAt)'
];
const FEAT_SLOTS = 4;
const POOLS_ADDR = '0xe848d695801EfF59B13104493aAD8Eeb24935663';
const POOLS_READ_ABI = [
  'function poolCount() view returns (uint256)',
  'function getPool(uint256) view returns (address token,uint8 quote,uint256 reserveToken,uint256 reserveQuote,address creator,bool locked,bool liquidityPulled,uint256 createdAt)'
];

// Для вкладки List & Trade проверяем, что пул существует и жив
async function findPoolByToken(token) {
  for (const url of RPCS) {
    try {
      const c = new ethers.Contract(POOLS_ADDR, POOLS_READ_ABI, mkProvider(url));
      const n = Number(await c.poolCount());
      for (let pid = n; pid >= 1; pid--) {
        const p = await c.getPool(pid);
        if (String(p[0]).toLowerCase() === String(token).toLowerCase()) {
          if (p[6]) return { err: 'Liquidity was withdrawn from this pool' };
          return { pid };
        }
      }
      return { err: 'No pool found for this token' };
    } catch (e) {}
  }
  return { err: 'Could not read pools' };
}

async function featPricePerDay(wallet) {
  const p = await loadPricing();
  if (!wallet || !isAddr(wallet)) return p.feat_public_usd;
  if (wallet.toLowerCase() === OWNER_WALLET.toLowerCase()) return 0;
  if (await passBalance(GOLD_PASS, wallet)   > 0n) return p.feat_gold_usd;
  if (await passBalance(SILVER_PASS, wallet) > 0n) return p.feat_silver_usd;
  return p.feat_public_usd;
}

async function featArePaused() {
  const p = await loadPricing();
  return !!p.feat_paused;
}

// Токен должен существовать на площадке — иначе оплатят пустой адрес
async function findTokenPad(token) {
  for (const url of RPCS) {
    for (const [pad, addr] of [['v2', LAUNCHPAD_V2_ADDR], ['v1', LAUNCHPAD_V1_ADDR]]) {
      try {
        const c = new ethers.Contract(addr, CURVE_READ_ABI, mkProvider(url));
        const r = await c.getCurve(token);
        if (r && r[0] && String(r[0]) !== '0x0000000000000000000000000000000000000000') return pad;
      } catch (e) {}
    }
  }
  return null;
}

// Проверка перевода USDT/USDC на кошелёк площадки — та же, что у рекламы
async function verifyPayment(wallet, token, txHash, needUsd) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { err: 'Bad tx hash' };
  if (!['USDT', 'USDC'].includes(token)) return { err: 'Bad token' };
  const tokenAddr = token === 'USDT' ? USDT_ADDR : USDC_ADDR;

  let receipt = null;
  for (const url of RPCS) {
    try { receipt = await mkProvider(url).getTransactionReceipt(txHash); if (receipt) break; } catch (e) {}
  }
  if (!receipt) return { err: 'Tx not found' };
  if (Number(receipt.status) !== 1) return { err: 'Tx failed' };

  const iface = mkIface(TRANSFER_EVENT);
  let value = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== tokenAddr.toLowerCase()) continue;
    let p; try { p = iface.parseLog(log); } catch (e) { continue; }
    if (!p || p.name !== 'Transfer') continue;
    if (String(p.args.from).toLowerCase() !== wallet.toLowerCase()) continue;
    if (String(p.args.to).toLowerCase() !== OWNER_WALLET.toLowerCase()) continue;
    value = p.args.value; break;
  }
  if (value === null) return { err: 'No matching payment found' };

  const paidUsd = Number(fmtEther(value));
  if (paidUsd < needUsd * 0.999) return { err: 'Payment amount too low' };
  return { paidUsd };
}

async function doFeatSubmit(body, res) {
  const { slot, tokenAddress, wallet, days, token, txHash } = body;
  const kind = body.kind === 'pool' ? 'pool' : 'launch';
  if (![1, 2, 3, 4].includes(Number(slot))) { res.status(400).json({ error: 'Bad slot' }); return; }
  if (!wallet || !isAddr(wallet)) { res.status(400).json({ error: 'Bad wallet' }); return; }
  if (!tokenAddress || !isAddr(tokenAddress)) { res.status(400).json({ error: 'Bad token address' }); return; }
  const daysNum = Math.floor(Number(days));
  if (!(daysNum > 0 && daysNum <= MAX_AD_DAYS)) { res.status(400).json({ error: 'Max ' + MAX_AD_DAYS + ' days' }); return; }

  if (await featArePaused()) { res.status(403).json({ error: 'Featured slots are temporarily closed' }); return; }

  const sb = sbClient();
  if (await isBlocked(sb, wallet)) { res.status(403).json({ error: 'This wallet is not allowed' }); return; }

  let pad = null, poolId = null;
  if (kind === 'pool') {
    const found = await findPoolByToken(tokenAddress);
    if (found.err) { res.status(404).json({ error: found.err }); return; }
    poolId = found.pid;
  } else {
    pad = await findTokenPad(tokenAddress);
    if (!pad) { res.status(404).json({ error: 'This token is not on LaunchLab' }); return; }
  }

  const perDay = await featPricePerDay(wallet);
  const pay = await verifyPayment(wallet, token, txHash, perDay * daysNum);
  if (pay.err) { res.status(400).json({ error: pay.err }); return; }

  const endAt = new Date(Date.now() + daysNum * 86400000).toISOString();
  const { data: newId, error } = await sb.rpc('place_featured_atomic', {
    p_slot: Number(slot), p_token: tokenAddress, p_pad: pad, p_wallet: wallet,
    p_tx_hash: txHash, p_paid_amount: pay.paidUsd, p_paid_token: token,
    p_days: daysNum, p_end_at: endAt, p_kind: kind, p_pool_id: poolId
  });
  if (error) {
    const m = String(error.message || '');
    if (m.includes('slot_occupied'))          { res.status(409).json({ error: 'Slot already taken' }); return; }
    if (m.includes('token_already_featured')) { res.status(409).json({ error: 'This token is already featured' }); return; }
    if (m.includes('tx_used'))                { res.status(409).json({ error: 'Transaction already used' }); return; }
    res.status(500).json({ error: error.message }); return;
  }
  res.status(200).json({ ok: true, id: newId });
}

async function doFeatExtend(body, res) {
  const { id, wallet, days, token, txHash } = body;
  const fid = Math.floor(Number(id));
  if (!(fid > 0)) { res.status(400).json({ error: 'Bad id' }); return; }
  if (!wallet || !isAddr(wallet)) { res.status(400).json({ error: 'Bad wallet' }); return; }
  const daysNum = Math.floor(Number(days));
  if (!(daysNum > 0 && daysNum <= MAX_AD_DAYS)) { res.status(400).json({ error: 'Max ' + MAX_AD_DAYS + ' days' }); return; }

  if (await featArePaused()) { res.status(403).json({ error: 'Featured slots are temporarily closed' }); return; }

  const sb = sbClient();
  if (await isBlocked(sb, wallet)) { res.status(403).json({ error: 'This wallet is not allowed' }); return; }

  const { data: row } = await sb.from('featured_tokens').select('id,wallet,removed,end_at').eq('id', fid).maybeSingle();
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  if (row.removed) { res.status(400).json({ error: 'Already removed' }); return; }
  if (String(row.wallet).toLowerCase() !== wallet.toLowerCase()) { res.status(403).json({ error: 'Not yours' }); return; }
  if (new Date(row.end_at).getTime() + daysNum * 86400000 > Date.now() + MAX_AD_DAYS * 86400000) {
    res.status(400).json({ error: 'Cannot book more than ' + MAX_AD_DAYS + ' days ahead' }); return;
  }

  const perDay = await featPricePerDay(wallet);
  const pay = await verifyPayment(wallet, token, txHash, perDay * daysNum);
  if (pay.err) { res.status(400).json({ error: pay.err }); return; }

  const { data: newEnd, error } = await sb.rpc('extend_featured_atomic', {
    p_id: fid, p_wallet: wallet, p_tx_hash: txHash,
    p_paid_amount: pay.paidUsd, p_paid_token: token,
    p_days: daysNum, p_max_days: MAX_AD_DAYS
  });
  if (error) {
    const m = String(error.message || '');
    if (m.includes('tx_used'))            { res.status(409).json({ error: 'Transaction already used' }); return; }
    if (m.includes('not_owner'))          { res.status(403).json({ error: 'Not yours' }); return; }
    if (m.includes('exceeds_max_window')) { res.status(400).json({ error: 'Cannot book more than ' + MAX_AD_DAYS + ' days ahead' }); return; }
    res.status(500).json({ error: error.message }); return;
  }
  res.status(200).json({ ok: true, endAt: newEnd });
}

async function doFeatRemove(body, res) {
  const { id, signature } = body;
  const fid = Math.floor(Number(id));
  if (!(fid > 0)) { res.status(400).json({ error: 'Bad id' }); return; }

  // Владелец площадки снимает любое место, покупатель — только своё
  const asOwner = recoverSigner('OpenGate admin remove featured #' + fid, signature);
  const asSelf  = recoverSigner('Remove my featured token #' + fid, signature);
  const signer  = (asOwner && asOwner.toLowerCase() === OWNER_WALLET.toLowerCase()) ? asOwner : asSelf;
  if (!signer) { res.status(400).json({ error: 'Bad signature' }); return; }

  const sb = sbClient();
  const { data: row } = await sb.from('featured_tokens').select('id,wallet,removed').eq('id', fid).maybeSingle();
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  if (row.removed) { res.status(200).json({ ok: true, alreadyRemoved: true }); return; }

  const isOwner = signer.toLowerCase() === OWNER_WALLET.toLowerCase();
  if (!isOwner && String(row.wallet).toLowerCase() !== signer.toLowerCase()) {
    res.status(403).json({ error: 'Not yours' }); return;
  }
  const { error } = await sb.from('featured_tokens').update({ removed: true }).eq('id', fid);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(200).json({ ok: true });
}

async function doFeatPause(body, res) {
  const { paused, ts, signature } = body;
  const want = !!paused;
  const auth = adminAuth('pause featured', want ? 'on' : 'off', ts, signature);
  if (auth.err) { res.status(403).json({ error: auth.err }); return; }
  const sb = sbClient();
  const { error } = await sb.from('ad_pricing').update({ feat_paused: want }).eq('id', 1);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(200).json({ ok: true, paused: want });
}
