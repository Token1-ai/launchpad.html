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
  const requiredMin = perDay * daysNum * 0.999;
  const paidUsd = Number(fmtEther(value));
  if (paidUsd < requiredMin) { res.status(400).json({ error: 'Payment amount too low for ' + daysNum + ' day(s)' }); return; }

  const endAt = new Date(Date.now() + daysNum * 86400000).toISOString();

  const { data: newId, error } = await sb.rpc('place_ad_atomic', {
    p_slot: Number(slot),
    p_wallet: wallet.toLowerCase(),
    p_image_url: String(imageUrl).slice(0, 300),
    p_link_url: String(linkUrl).slice(0, 300),
    p_tx_hash: txHash,
    p_paid_amount: paidUsd,
    p_paid_token: token,
    p_days: daysNum,
    p_end_at: endAt
  });
  if (error) {
    if (error.message && error.message.includes('slot_occupied')) { res.status(409).json({ error: 'Slot already occupied' }); return; }
    res.status(500).json({ error: error.message }); return;
  }
  res.status(200).json({ ok: true });
}
