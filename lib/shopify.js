// Shopify sync — mapping from Shopify orders to bake plans.
// Pure functions (no I/O) so they can be tested against fixture orders
// from the CSV export, without touching the live store.
//
// Facts from Maurice's real orders (2026-11-17, orders #1001-#1015):
// - Only 3 products. Brownies have SKU NB-SSB-16; cookies and brookies
//   have no SKU. Product names change over time ("Chocolate Brownies" vs
//   "Brownies"), so match by Shopify product/variant ID first, then SKU,
//   then title. Never match by exact title alone.
// - Bake date lives in the order's Note Attributes, as structured
//   name/value pairs in the API: "Delivery Date: 15-11-2026" or
//   "Pickup Date: 14-11-2026" (DD-MM-YYYY), sometimes also
//   "_Delivery Date: 2026-10-15" (ISO). Plus "Delivery Time" /
//   "Pickup Time" and "Delivery Method" (delivery/pickup, any case).
// - 2 day lead time, enforced by the date picker. Never fall back to the
//   order date: Maurice never bakes on the same day as the order date.
//   An order with no date is flagged, never planned on the order date.
// - Box of 16 brownies = 1 brownie portion. Box of 16 brookie = 1 brookie.
//   Box of 6 cookies = 6 frozen cookie dough balls. Check balls on hand
//   first; only make new dough batches for the shortfall, in whole
//   batches of 12 balls.
// - Cancelled orders (#1001, #1002) must be skipped, and a planned plan
//   for an order that is later cancelled must be removed, unless it was
//   already baked.

// Parse Note Attributes (array of {name, value} from the API, or a
// "Name: value\nName: value" string as in the CSV export) into
// { method, date, time } where date is YYYY-MM-DD, or null if no date.
function parseNoteAttributes(noteAttributes) {
  const pairs = [];
  if (Array.isArray(noteAttributes)) {
    for (const a of noteAttributes) {
      if (a && a.name) pairs.push([String(a.name).trim(), String(a.value ?? '').trim()]);
    }
  } else if (typeof noteAttributes === 'string') {
    for (const line of noteAttributes.split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) pairs.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    }
  }
  const get = (name) => {
    const p = pairs.find(([n]) => n.toLowerCase() === name.toLowerCase());
    return p ? p[1] : null;
  };
  const methodRaw = get('Delivery Method');
  const method = methodRaw ? methodRaw.toLowerCase() : null;
  const dateRaw = get('Delivery Date') || get('Pickup Date') || get('_Delivery Date');
  const timeRaw = get('Delivery Time') || get('Pickup Time');
  let date = null;
  if (dateRaw) {
    // DD-MM-YYYY, as written by the date-picker app.
    const dm = dateRaw.match(/^(\d{2})-(\d{2})-(\d{4})/);
    if (dm) date = `${dm[3]}-${dm[2]}-${dm[1]}`;
    // YYYY-MM-DD, as in the _Delivery Date attribute.
    const iso = dateRaw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) date = `${iso[1]}-${iso[2]}-${iso[3]}`;
  }
  return { method, date, time: timeRaw || null };
}

// Map one Shopify line item to a recipe. Returns
// { recipeId, qty } or { unknown: reason }.
// Matching order: Shopify product/variant ID (stable), then SKU, then title.
// The product ID table is filled in from the first live pull; titles and
// SKU are the fallback until then.
function mapLineItem(line, productIds = {}) {
  const title = (line.title || '').toLowerCase();
  const sku = (line.sku || '').trim();
  const pid = String(line.product_id || line.variant_id || '');
  if (pid && productIds[pid]) return { recipeId: productIds[pid], qty: Number(line.quantity) || 0 };
  if (sku === 'NB-SSB-16') return { recipeId: 'brownies', qty: Number(line.quantity) || 0 };
  if (title.includes('brookie')) return { recipeId: 'brookie', qty: Number(line.quantity) || 0 };
  if (title.includes('cookie')) return { recipeId: 'cookies-from-balls', qty: Number(line.quantity) || 0 };
  if (title.includes('brownie')) return { recipeId: 'brownies', qty: Number(line.quantity) || 0 };
  return { unknown: `No recipe mapping for "${line.title || 'unnamed product'}" (sku: ${sku || 'none'})` };
}

// Turn one Shopify order into a bake plan, or into a flag.
// ballsOnHand is the current frozen cookie dough ball count.
// Returns { plan } or { flag }.
// plan: { shopifyOrderId, shopifyOrderName, customer, name, date, time,
//         method, items, dough } where dough is { batchesMade } or null.
function orderToPlan(order, ballsOnHand, productIds = {}) {
  const orderId = String(order.id);
  const orderName = order.name || `#${orderId}`;
  const customer = order.customer ? [order.customer.first_name, order.customer.last_name].filter(Boolean).join(' ') : null;
  if (order.cancelled_at) {
    return { flag: { kind: 'cancelled', shopifyOrderId: orderId, shopifyOrderName: orderName, reason: 'Order was cancelled' } };
  }
  const { method, date, time } = parseNoteAttributes(order.note_attributes);
  if (!date) {
    return { flag: { kind: 'no-date', shopifyOrderId: orderId, shopifyOrderName: orderName, reason: 'No pickup or delivery date on this order. Never bake on the order date.' } };
  }
  const items = [];
  for (const line of order.line_items || []) {
    const m = mapLineItem(line, productIds);
    if (m.unknown) {
      return { flag: { kind: 'unmapped', shopifyOrderId: orderId, shopifyOrderName: orderName, reason: m.unknown } };
    }
    if (m.qty > 0) {
      const ex = items.find(i => i.recipeId === m.recipeId);
      if (ex) ex.qty += m.qty; else items.push({ recipeId: m.recipeId, qty: m.qty });
    }
  }
  if (!items.length) {
    return { flag: { kind: 'empty', shopifyOrderId: orderId, shopifyOrderName: orderName, reason: 'Order has no bakeable items' } };
  }
  // Dough batches: brookies need 0.5 batch each, made fresh in the plan.
  // Cookie boxes use frozen balls; only make batches for the shortfall.
  const brookieQty = (items.find(i => i.recipeId === 'brookie') || { qty: 0 }).qty;
  const cookieBoxes = (items.find(i => i.recipeId === 'cookies-from-balls') || { qty: 0 }).qty;
  const ballsNeeded = cookieBoxes * 6;
  const brookieDough = brookieQty * 0.5;
  const shortfall = Math.max(0, ballsNeeded - ballsOnHand);
  const extraBatches = Math.ceil(shortfall / 12);
  const batchesMade = Math.ceil(brookieDough - 1e-9) + extraBatches;
  return {
    plan: {
      shopifyOrderId: orderId,
      shopifyOrderName: orderName,
      customer,
      name: `${orderName}${customer ? ` ${customer}` : ''}`,
      date, time, method,
      items,
      dough: batchesMade > 0 ? { batchesMade } : null,
    },
  };
}

// Decide what a pull of orders does to the existing bake plans.
// orders: Shopify orders (newest first is fine). plans: existing bake
// plans. ballsOnHand: current frozen ball count.
// Returns { create, update, remove, flags, skipped } where create/update
// are plan objects, remove are plan ids, flags are { kind, ... } and
// skipped are { shopifyOrderId, reason } for orders left alone.
function syncOrders(orders, plans, ballsOnHand, productIds = {}) {
  const create = [], update = [], remove = [], flags = [], skipped = [];
  const byOrder = new Map();
  for (const p of plans) {
    if (p.shopifyOrderId) byOrder.set(String(p.shopifyOrderId), p);
  }
  for (const order of orders) {
    const orderId = String(order.id);
    const existing = byOrder.get(orderId);
    if (order.cancelled_at) {
      if (existing && existing.status === 'planned') remove.push(existing.id);
      else if (existing) skipped.push({ shopifyOrderId: orderId, reason: 'Order cancelled, but the bake plan was already completed. Check it by hand.' });
      continue;
    }
    const { plan, flag } = orderToPlan(order, ballsOnHand, productIds);
    if (flag) { flags.push(flag); continue; }
    if (!existing) { create.push(plan); continue; }
    if (existing.status !== 'planned') {
      skipped.push({ shopifyOrderId: orderId, reason: 'Bake plan already completed. Order changes do not change it.' });
      continue;
    }
    const same = existing.date === plan.date
      && JSON.stringify(existing.items) === JSON.stringify(plan.items)
      && JSON.stringify(existing.dough || null) === JSON.stringify(plan.dough || null);
    if (!same) update.push({ ...existing, ...plan });
  }
  return { create, update, remove, flags, skipped };
}

export { parseNoteAttributes, mapLineItem, orderToPlan, syncOrders };
