// Nami Bakes frontend. All data comes from the server API (/api/*).
// Nothing about stock/recipes is stored in localStorage, except the shared
// password, which is remembered on this device so unlocking is a one-time
// step per device, not per visit.
const api = (p, opts = {}) => {
  const key = localStorage.getItem('mep-api-key');
  const headers = { ...(opts.headers || {}) };
  if (key) headers['x-api-key'] = key;
  return fetch(p, { ...opts, headers }).then(async r => { const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { raw: t }; } if (!r.ok) { const e = new Error(j.error || t); e.status = r.status; throw e; } return j; });
};
function showLock() { document.getElementById('lock-screen').style.display = ''; document.getElementById('lock-error').textContent = ''; }
async function unlock() {
  const key = document.getElementById('lock-password').value;
  if (!key) return;
  localStorage.setItem('mep-api-key', key);
  try { await loadAll(); document.getElementById('lock-screen').style.display = 'none'; }
  catch (e) { localStorage.removeItem('mep-api-key'); document.getElementById('lock-error').textContent = 'Wrong password, try again.'; }
}
async function downloadBackup() {
  const data = await api('/api/backup');
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mise-en-place-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
}
async function restoreBackup(file) {
  if (!file) return;
  if (!confirm('Restore this backup? It will replace all current stock, recipes, plans and history.')) return;
  const data = JSON.parse(await file.text());
  const r = await api('/api/backup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  alert(`Backup restored: ${r.ingredients} ingredients, ${r.recipes} recipes, ${r.bakePlans} bake plans.`);
  await loadAll(); await loadHistory();
}
const fmt = n => { const r = Math.round((Number(n) + Number.EPSILON) * 1000) / 1000; return String(r); };
let ingredients = [], recipes = [], plans = [];

// Theme and dashboard are per-browser display preferences, saved in
// localStorage. Stock, recipes and plans are server data, never stored here.
function applyTheme() {
  const dark = (localStorage.getItem('mep-theme') || 'light') === 'dark';
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.getElementById('theme-toggle').textContent = dark ? 'Light mode' : 'Dark mode';
}
function applyDashboard() {
  const on = (localStorage.getItem('mep-dashboard') || 'on') === 'on';
  document.getElementById('dashboard').style.display = on ? '' : 'none';
  document.getElementById('dashboard-toggle').textContent = on ? 'Dashboard: On' : 'Dashboard: Off';
  if (on) renderDashboard();
}
document.getElementById('theme-toggle').onclick = () => {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  localStorage.setItem('mep-theme', dark ? 'light' : 'dark');
  applyTheme();
};
document.getElementById('dashboard-toggle').onclick = () => {
  const on = document.getElementById('dashboard').style.display !== 'none';
  localStorage.setItem('mep-dashboard', on ? 'off' : 'on');
  applyDashboard();
};
// Singular / plural for a planned item, e.g. 1 brownie, 2 brownies.
function itemLabel(recipeId, qty) {
  const r = recipes.find(x => x.id === recipeId);
  const name = r ? r.name : recipeId;
  if (qty <= 1) {
    if (name === 'Brownies') return 'Brownie';
    if (name === 'Cookies (from balls)') return 'Box of cookies';
    if (name.endsWith('ies')) return name.slice(0, -3) + 'y';
    if (name.endsWith('s')) return name.slice(0, -1);
    return name;
  }
  if (name === 'Cookies (from balls)') return 'Boxes of cookies';
  if (name.endsWith('s')) return name;
  if (name.endsWith('y')) return name.slice(0, -1) + 'ies';
  return name + 's';
}
function niceDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-SG', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
function renderDashboard() {
  const balls = ingredients.find(i => i.id === 'cookie-dough-balls');
  const low = ingredients.filter(i => i.min > 0 && i.current <= i.min * 1.5);
  const next = plans.filter(p => p.status === 'planned').sort((a, b) => (a.date || '').localeCompare(b.date || ''))[0];
  const closest = [...ingredients].filter(i => i.min > 0).sort((a, b) => (a.current / a.min) - (b.current / b.min)).slice(0, 2);
  document.getElementById('dashboard-cards').innerHTML = `
  <div class="dash-card"><h3>Cookie dough balls</h3><div class="big">${balls ? fmt(balls.current) : '0'}</div><p>frozen, ready to bake</p></div>
  <div class="dash-card"><h3>Low stock</h3><div class="big">${low.length} ${low.length === 1 ? 'item' : 'items'} low</div><p>${low.length ? low.map(i => `${i.name}: ${fmt(i.current)} / min ${fmt(i.min)} ${i.unit}${i.current <= i.min ? ' (below min)' : ''}`).join('<br>') : 'All stock healthy'}</p></div>
  <div class="dash-card"><h3>Next bake</h3><div class="big" style="font-size:22px">${next ? next.name : 'None planned'}</div><p>${next ? `${niceDate(next.date)}<br>${next.items.map(i => `${fmt(i.qty)} × ${itemLabel(i.recipeId, i.qty)}`).join('<br>')}` : 'Plan one in Batch Planning'}</p></div>
  <div class="dash-card"><h3>Closest to minimum</h3><div class="big" style="font-size:22px">${closest.map(i => i.name).join('<br>')}</div><p>${closest.map(i => `${i.name}: ${fmt(i.current)} / min ${fmt(i.min)} ${i.unit}`).join('<br>')}</p></div>`;
}

document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  document.querySelectorAll('nav button').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  document.getElementById('tab-' + b.dataset.tab).classList.add('active');
  if (b.dataset.tab === 'shopping') loadShopping();
  if (b.dataset.tab === 'planning') loadPlans();
  if (b.dataset.tab === 'history') loadHistory();
});

async function loadAll() {
  try {
    ingredients = await api('/api/inventory');
    recipes = await api('/api/recipes');
  } catch (e) {
    if (e.status === 401) { showLock(); throw e; }
    throw e;
  }
  renderInventory(); renderRecipes(); renderPlanLines();
  try { await loadPlans(); } catch (e) {}
  renderDashboard();
}
function renderInventory() {
  document.getElementById('inventory-list').innerHTML = ingredients.map(i => {
    const ratio = i.min > 0 ? i.current / i.min : (i.current > 0 ? 99 : 0);
    const tier = i.current <= i.min ? 'below' : (ratio <= 1.5 ? 'low' : 'ok');
    const tierLabel = tier === 'below' ? 'Below minimum' : (tier === 'low' ? 'Getting low' : 'Healthy');
    const tierClass = tier === 'below' ? 'warn' : (tier === 'low' ? 'low-text' : 'ok-text');
    const pct = Math.min(100, Math.round(i.current / Math.max(i.min * 3, 1) * 100));
    return `<div class="card"><div class="row"><strong>${i.name}</strong><span class="${tierClass}">${tierLabel}</span></div>
    <div>Current Stock: <input type="number" step="any" value="${i.current}" data-id="${i.id}" data-field="current" style="width:120px"> ${i.unit}</div>
    <div>Min Stock: <input type="number" step="any" value="${i.min}" data-id="${i.id}" data-field="min" style="width:120px"> ${i.unit}</div>
    <div class="bar ${tier}"><div style="width:${pct}%"></div></div>
    <p class="bar-label">${fmt(ratio)}x minimum, ${pct}% of a comfortable level (3x minimum). ${tier === 'below' ? 'This bar is red because stock is at or below minimum.' : (tier === 'low' ? 'This bar is gold because stock is only just above minimum.' : 'This bar is teal because stock is comfortably above minimum.')}</p>
    <button class="ghost" onclick="deleteIngredient('${i.id}')">Delete</button></div>`;
  }).join('');
  document.querySelectorAll('#inventory-list input').forEach(inp => inp.onchange = async () => {
    const raw = inp.value.trim();
    const val = Number(raw);
    if (raw === '' || !Number.isFinite(val)) { await loadAll(); return; }
    if (inp.dataset.field === 'current' && val === 0) {
      const ing = ingredients.find(x => x.id === inp.dataset.id);
      const name = ing ? ing.name : 'this ingredient';
      if (!confirm(`Set ${name} stock to 0? This will put it on the shopping list. Choose OK only if you are really out of ${name}.`)) { await loadAll(); return; }
    }
    if (inp.dataset.field === 'current') {
      const ing = ingredients.find(x => x.id === inp.dataset.id);
      const old = ing ? ing.current : 0;
      if (old > 0 && (val > old * 1.5 || val < old * 0.5)) {
        if (!confirm(`${ing.name}: ${fmt(old)} to ${fmt(val)} is a big change, more than 50%. Did you mean ${fmt(val)} ${ing.unit}, or did you type the wrong number or unit? Choose OK only if ${fmt(val)} is right.`)) { await loadAll(); return; }
      }
    }
    await api('/api/inventory/' + inp.dataset.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [inp.dataset.field]: val }) });
    await loadAll();
  });
}
async function deleteIngredient(id) { if (confirm('Delete this ingredient?')) { await api('/api/inventory/' + id, { method: 'DELETE' }); await loadAll(); } }
document.getElementById('add-ingredient').onclick = () => document.getElementById('ingredient-form').classList.remove('hidden');
document.getElementById('cancel-ingredient').onclick = () => document.getElementById('ingredient-form').classList.add('hidden');
document.getElementById('save-ingredient').onclick = async () => {
  await api('/api/inventory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: document.getElementById('new-name').value, unit: document.getElementById('new-unit').value, current: Number(document.getElementById('new-current').value), min: Number(document.getElementById('new-min').value) }) });
  await loadAll();
};
let editingRecipeId = null;
function renderRecipes() {
  document.getElementById('recipe-list').innerHTML = recipes.map(r => `<div class="card"><strong>🧑‍🍳 ${r.name}</strong><p>${r.description || ''}</p><span class="badge">Yields: ${r.yields} ${r.yieldUnit || 'portions'}</span><table>${r.ingredients.map(i => { const ing = ingredients.find(x => x.id === i.ingredientId); return `<tr><td>${ing ? ing.name : i.ingredientId}</td><td>${fmt(i.qty)} ${i.unit}</td></tr>`; }).join('')}</table><div class="row" style="margin-top:10px"><button class="ghost small" onclick="editRecipe('${r.id}')">Edit recipe</button><button class="danger small" onclick="deleteRecipe('${r.id}')">Delete</button></div></div>`).join('');
}
function addRecipeIngLine(ingredientId, qty, unit) {
  const div = document.createElement('div'); div.className = 'row recipe-ing-line';
  const known = ingredients.find(x => x.id === ingredientId);
  const unknownOpt = (!known && ingredientId) ? `<option value="${ingredientId}" selected>${ingredientId} (not in Inventory)</option>` : '';
  div.innerHTML = `<select style="flex:2"><option value="">Pick an ingredient</option>${unknownOpt}${ingredients.map(x => `<option value="${x.id}" ${x.id === ingredientId ? 'selected' : ''}>${x.name}</option>`).join('')}</select><input type="number" step="any" min="0" value="${qty ?? ''}" style="width:90px" placeholder="Qty"><input type="text" value="${unit ?? ''}" style="width:70px" placeholder="Unit"><button type="button" class="ghost small remove-ing">Remove</button>`;
  const select = div.querySelector('select'), unitEl = div.querySelectorAll('input')[1];
  select.onchange = () => {
    const ing = ingredients.find(x => x.id === select.value);
    if (ing && !unitEl.value) unitEl.value = ing.unit;
  };
  div.querySelector('.remove-ing').onclick = () => div.remove();
  document.getElementById('recipe-ing-lines').appendChild(div);
}
function collectRecipeIngs() {
  return [...document.querySelectorAll('#recipe-ing-lines .recipe-ing-line')].map(row => {
    const [qtyEl, unitEl] = row.querySelectorAll('input');
    return { ingredientId: row.querySelector('select').value, qty: Number(qtyEl.value), unit: unitEl.value.trim() };
  });
}
document.getElementById('add-recipe-ing').onclick = () => addRecipeIngLine();
function resetRecipeForm() {
  editingRecipeId = null;
  document.getElementById('recipe-form-title').textContent = 'Add recipe (per portion)';
  document.getElementById('save-recipe').textContent = 'Add Recipe';
  document.getElementById('new-recipe-name').value = '';
  document.getElementById('new-recipe-desc').value = '';
  document.getElementById('new-recipe-yields').value = 1;
  document.getElementById('new-recipe-yield-unit').value = 'portions';
  document.getElementById('new-recipe-pack-size').value = 1;
  document.getElementById('new-recipe-sell-price').value = '';
  document.getElementById('recipe-ing-lines').innerHTML = '';
  addRecipeIngLine();
  document.getElementById('recipe-form').classList.add('hidden');
}
function editRecipe(id) {
  const r = recipes.find(x => x.id === id); if (!r) return;
  editingRecipeId = id;
  document.getElementById('recipe-form-title').textContent = 'Edit recipe: ' + r.name;
  document.getElementById('save-recipe').textContent = 'Save changes';
  document.getElementById('new-recipe-name').value = r.name;
  document.getElementById('new-recipe-desc').value = r.description || '';
  document.getElementById('new-recipe-yields').value = r.yields || 1;
  document.getElementById('new-recipe-yield-unit').value = r.yieldUnit || 'portions';
  document.getElementById('new-recipe-pack-size').value = r.packSize || 1;
  document.getElementById('new-recipe-sell-price').value = r.sellPrice === null || r.sellPrice === undefined ? '' : r.sellPrice;
  document.getElementById('recipe-ing-lines').innerHTML = '';
  (r.ingredients || []).forEach(i => addRecipeIngLine(i.ingredientId, i.qty, i.unit));
  if (!(r.ingredients || []).length) addRecipeIngLine();
  document.getElementById('recipe-form').classList.remove('hidden');
  document.getElementById('recipe-form').scrollIntoView({ behavior: 'smooth' });
}
async function deleteRecipe(id) { const r = recipes.find(x => x.id === id); if (confirm(`Delete recipe "${r ? r.name : id}"?`)) { await api('/api/recipes/' + id, { method: 'DELETE' }); await loadAll(); } }
document.getElementById('add-recipe').onclick = () => { resetRecipeForm(); document.getElementById('recipe-form').classList.remove('hidden'); };
document.getElementById('cancel-recipe').onclick = resetRecipeForm;
document.getElementById('save-recipe').onclick = async () => {
  const ings = collectRecipeIngs().filter(i => i.ingredientId || i.qty);
  for (const i of ings) {
    if (!i.ingredientId) { alert('Pick an ingredient for every row, or remove the empty row.'); return; }
    if (!ingredients.some(x => x.id === i.ingredientId)) { alert(`"${i.ingredientId}" is not in Inventory. Add it to Inventory first, then add it to the recipe.`); return; }
    if (!i.qty || i.qty <= 0) { alert('Every ingredient needs a quantity more than 0.'); return; }
    if (!i.unit) { const ing = ingredients.find(x => x.id === i.ingredientId); i.unit = ing ? ing.unit : ''; }
  }
  const sellPrice = document.getElementById('new-recipe-sell-price').value;
  const body = { name: document.getElementById('new-recipe-name').value, description: document.getElementById('new-recipe-desc').value, yields: Number(document.getElementById('new-recipe-yields').value) || 1, yieldUnit: document.getElementById('new-recipe-yield-unit').value || 'portions', packSize: Number(document.getElementById('new-recipe-pack-size').value) || 1, sellPrice: sellPrice === '' ? null : Number(sellPrice), ingredients: ings };
  if (editingRecipeId) {
    await api('/api/recipes/' + editingRecipeId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } else {
    await api('/api/recipes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  resetRecipeForm(); await loadAll();
};
function renderPlanLines() {
  const el = document.getElementById('plan-lines');
  if (!el.dataset.init) { el.dataset.init = '1'; addPlanLine(); }
}
let editingPlanId = null;
function addPlanLine(recipeId, qty) {
  const div = document.createElement('div'); div.className = 'row plan-line';
  div.innerHTML = `<select>${recipes.filter(r => r.id !== 'cookie-dough').map(r => `<option value="${r.id}" ${r.id === recipeId ? 'selected' : ''}>${r.name}</option>`).join('')}</select><input type="number" step="0.5" min="0" value="${qty ?? 1}" style="width:100px" placeholder="Qty"><button type="button" class="ghost small remove-line">Remove</button>`;
  div.querySelector('.remove-line').onclick = () => {
    const lines = document.querySelectorAll('#plan-lines .plan-line');
    if (lines.length <= 1) { alert('A bake needs at least one item. Change this line instead of removing it.'); return; }
    div.remove();
  };
  document.getElementById('plan-lines').appendChild(div);
}
document.getElementById('add-plan-line').onclick = addPlanLine;
function planItems() {
  return [...document.querySelectorAll('#plan-lines .row')].map(row => ({ recipeId: row.querySelector('select').value, qty: Number(row.querySelector('input').value) })).filter(x => x.qty > 0);
}
function planDough() {
  const v = document.getElementById('dough-batches-made').value;
  return v === '' || v === null ? undefined : { batchesMade: Number(v) };
}
function showPlan(calc) {
  const el = document.getElementById('plan-result');
  const doughLine = (calc.doughBatchesMade !== undefined && calc.doughBatchesMade !== null)
    ? `<p><strong>Cookie dough:</strong> make ${fmt(calc.doughBatchesMade)} ${calc.doughBatchesMade === 1 ? 'batch' : 'batches'}, use ${fmt(calc.doughUsed || 0)} ${calc.doughUsed === 1 ? 'batch' : 'batches'} in this bake, freeze ${fmt(calc.ballsAdded || 0)} balls.</p>`
    : '';
  el.innerHTML = `<div class="card"><h3>Sub-recipes — make each in one go</h3>
  ${doughLine}
  ${calc.subRecipes.map(sr => `<h4>${sr.name} — ${fmt(sr.portions)} ${sr.portionsUnit || 'portions'}</h4><table>${sr.ingredients.map(i => `<tr><td>${i.name}</td><td>${fmt(i.qty)} ${i.unit}</td></tr>`).join('')}</table>`).join('')}
  ${calc.direct.length ? `<h4>Direct</h4><table>${calc.direct.map(i => `<tr><td>${i.name}</td><td>${fmt(i.qty)} ${i.unit}</td></tr>`).join('')}</table>` : ''}
  <h4>Total ingredients needed</h4><table>${calc.totals.map(i => `<tr><td>${i.name}</td><td>${fmt(i.qty)} ${i.unit}</td></tr>`).join('')}</table>
  ${calc.insufficient.length ? `<p class="warn">Not enough stock: ${calc.insufficient.map(i => `${i.name} short by ${fmt(i.shortBy)} ${i.unit}`).join(', ')}</p>` : '<p>Stock is sufficient for this plan.</p>'}
  ${calc.totalCost !== undefined ? `<h4>Cost</h4><p>${calc.missingPrices && calc.missingPrices.length ? `Cost is incomplete, no price recorded yet for: ${calc.missingPrices.join(', ')}. Add a price when you restock to see the full cost.` : ''}</p><p>Ingredient cost: $${calc.totalCost.toFixed(2)}${calc.totalSell ? `<br>Selling price: $${calc.totalSell.toFixed(2)}<br>Margin: $${calc.margin.toFixed(2)}` : '<br>Add a selling price to the recipe to see the margin.'}</p>` : ''}
  </div>`;
  const dough = planDough();
  if (calc.doughBatchesMade !== undefined && calc.doughBatchesMade !== null && dough === undefined) {
    document.getElementById('dough-batches-made').value = calc.doughBatchesMade;
  }
  document.getElementById('dough-preview').textContent = calc.ballsAdded > 0
    ? `On completing this plan, ${fmt(calc.ballsAdded)} balls go to the freezer.`
    : '';
}
document.getElementById('calc-plan').onclick = async () => {
  try {
    const dough = planDough();
    const body = { items: planItems() };
    if (dough) body.doughBatchesMade = dough.batchesMade;
    showPlan(await api('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  } catch (e) { document.getElementById('plan-result').innerHTML = `<div class="card"><p class="warn">${e.message}</p></div>`; }
};
document.getElementById('save-plan').onclick = async () => {
  try {
    const dough = planDough();
    const body = { name: document.getElementById('plan-name').value || 'Bake plan', date: document.getElementById('plan-date').value || new Date().toISOString().slice(0, 10), items: planItems() };
    if (dough) body.doughBatchesMade = dough.batchesMade;
    let plan;
    if (editingPlanId) {
      plan = await api('/api/bake-plans/' + editingPlanId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      cancelPlanEdit();
    } else {
      plan = await api('/api/bake-plans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }
    showPlan(plan.calculation); await loadPlans();
  } catch (e) { alert(e.message); }
};
function cancelPlanEdit() {
  editingPlanId = null;
  document.getElementById('save-plan').textContent = 'Save plan';
  document.getElementById('cancel-edit-plan').classList.add('hidden');
}
document.getElementById('cancel-edit-plan').onclick = () => {
  cancelPlanEdit();
  document.getElementById('plan-lines').innerHTML = '';
  document.getElementById('plan-lines').dataset.init = '';
  document.getElementById('plan-name').value = '';
  document.getElementById('dough-batches-made').value = '';
  renderPlanLines();
};
function editPlan(id) {
  const p = plans.find(x => x.id === id);
  if (!p || p.status !== 'planned') { alert('Only a planned bake plan can be edited.'); return; }
  editingPlanId = id;
  document.getElementById('plan-lines').innerHTML = '';
  if (p.items.length) p.items.forEach(i => addPlanLine(i.recipeId, i.qty));
  else addPlanLine();
  document.getElementById('plan-name').value = p.name || '';
  document.getElementById('plan-date').value = p.date || '';
  document.getElementById('dough-batches-made').value = p.dough ? p.dough.batchesMade : '';
  document.getElementById('save-plan').textContent = 'Update plan';
  document.getElementById('cancel-edit-plan').classList.remove('hidden');
  document.querySelector('#tab-planning .card').scrollIntoView({ behavior: 'smooth' });
}
async function deletePlan(id) {
  const p = plans.find(x => x.id === id);
  const note = p && p.status === 'completed' ? ' This plan is already completed, so deleting it will not put the ingredients back.' : ' Nothing will be deducted from stock.';
  if (!confirm(`Delete the bake plan "${p ? p.name : id}"?${note}`)) return;
  await api('/api/bake-plans/' + id, { method: 'DELETE' });
  if (editingPlanId === id) cancelPlanEdit();
  await loadPlans();
}
async function loadPlans() {
  plans = await api('/api/bake-plans');
  document.getElementById('saved-plans').innerHTML = plans.map(p => `<div class="card"><strong>${p.name}</strong> — ${p.date} — ${p.status}<br>${p.items.map(i => { const r = recipes.find(x => x.id === i.recipeId); return `${fmt(i.qty)} × ${r ? r.name : i.recipeId}`; }).join(', ') || 'Dough only'}${p.dough ? `<br>Dough: ${fmt(p.dough.batchesMade)} ${p.dough.batchesMade === 1 ? 'batch' : 'batches'}${p.calculation && p.calculation.ballsAdded ? `, freeze ${fmt(p.calculation.ballsAdded)} balls` : ''}` : ''}<br>${p.status === 'planned' ? `<button onclick="completePlan('${p.id}')">Complete bake (deduct stock)</button> <button class="ghost" onclick="editPlan('${p.id}')">Edit</button> ` : ''}<button class="ghost" onclick="deletePlan('${p.id}')">Delete</button></div>`).join('') || '<p>No bake plans yet.</p>';
}
async function completePlan(id) {
  const r = await api('/api/bake-plans/' + id + '/complete', { method: 'POST' });
  if (r.ballsAdded > 0) alert(`Bake completed. ${r.ballsAdded} balls added to the freezer.`);
  await loadAll(); await loadPlans();
}
async function loadShopping() {
  const data = await api('/api/shopping-list');
  document.getElementById('friday-note').textContent = 'Next Friday shop: ' + data.nextFriday;
  const list = document.getElementById('shopping-list');
  if (!data.items.length) { list.innerHTML = '<p>All stock levels are healthy.</p>'; window._shopping = data; return; }
  list.innerHTML = data.items.map(i => {
    const units = i.purchaseUnits || [{ unit: i.unit, label: i.unit, perUnit: 1 }];
    return `<div class="card" data-ingredient="${i.ingredientId}">
      <label><input type="checkbox" class="restock-bought"> Bought</label>
      <strong>${i.name}</strong> — Need ${fmt(i.need)} ${i.unit} (have ${fmt(i.have)}, min ${fmt(i.min)}) — ${i.reason}<br>
      ${i.shortBeforeNextShop ? `<p class="warn">Short before the next shop${i.shortDate && i.shortDate !== 'now' ? `, on ${i.shortDate}` : ''}. Buy this sooner if you can.</p>` : (i.shortDate ? `<p class="hint">Runs short on ${i.shortDate}.</p>` : '')}
      <label>Bought <input type="number" class="restock-amount" value="${fmt(i.need)}" min="0" step="any" style="width:100px"></label>
      <select class="restock-unit">${units.map(u => `<option value="${u.unit}" data-per-unit="${u.perUnit}" ${u.unit === i.unit ? 'selected' : ''}>${u.label}</option>`).join('')}</select>
      <label>Price paid (SGD, optional) <input type="number" class="restock-price" min="0" step="any" style="width:110px" placeholder="e.g. 12.50"></label>
      <p class="restock-preview hint"></p>
      <button class="restock-add" disabled>Add to inventory</button>
    </div>`;
  }).join('');
  window._shopping = data;
  list.querySelectorAll('.card').forEach(card => {
    const item = data.items.find(x => x.ingredientId === card.dataset.ingredient);
    const bought = card.querySelector('.restock-bought');
    const amountEl = card.querySelector('.restock-amount');
    const unitEl = card.querySelector('.restock-unit');
    const preview = card.querySelector('.restock-preview');
    const addBtn = card.querySelector('.restock-add');
    const updatePreview = () => {
      const perUnit = Number(unitEl.selectedOptions[0].dataset.perUnit);
      const amount = Number(amountEl.value);
      if (!amount || amount <= 0 || !perUnit) { preview.textContent = ''; return; }
      const added = Math.round(amount * perUnit * 1000) / 1000;
      preview.textContent = `${fmt(amount)} ${unitEl.value} = ${fmt(added)} ${item.unit} in stock. New stock will be ${fmt(Math.round((item.have + added) * 1000) / 1000)} ${item.unit}.`;
    };
    unitEl.onchange = () => {
      // Keep the converted total the same when switching units.
      const oldPerUnit = Number(unitEl.dataset.prevPerUnit || unitEl.selectedOptions[0].dataset.perUnit);
      const perUnit = Number(unitEl.selectedOptions[0].dataset.perUnit);
      const amount = Number(amountEl.value);
      if (amount > 0 && oldPerUnit && perUnit) amountEl.value = Math.round((amount * oldPerUnit / perUnit) * 100) / 100;
      unitEl.dataset.prevPerUnit = perUnit;
      updatePreview();
    };
    unitEl.dataset.prevPerUnit = Number(unitEl.selectedOptions[0].dataset.perUnit);
    amountEl.oninput = updatePreview; unitEl.onchange = unitEl.onchange;
    bought.onchange = () => { addBtn.disabled = !bought.checked; };
    updatePreview();
    addBtn.onclick = async () => {
      const amount = Number(amountEl.value), unit = unitEl.value;
      if (!amount || amount <= 0) { alert('Enter how much you bought first.'); return; }
      const perUnit = Number(unitEl.selectedOptions[0].dataset.perUnit);
      const added = Math.round(amount * perUnit * 1000) / 1000;
      if (!confirm(`Add ${fmt(amount)} ${unit} of ${item.name} to inventory? That is ${fmt(added)} ${item.unit}. Stock will go from ${fmt(item.have)} to ${fmt(Math.round((item.have + added) * 1000) / 1000)} ${item.unit}.`)) return;
      try {
        const priceEl = card.querySelector('.restock-price');
        const price = priceEl && priceEl.value !== '' ? Number(priceEl.value) : undefined;
        const body = { ingredientId: item.ingredientId, amount, unit };
        if (price !== undefined) body.price = price;
        const r = await api('/api/restock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        alert(`Added ${fmt(r.added)} ${r.unit} of ${r.name}. Stock is now ${fmt(r.after)} ${r.unit}.`);
        await loadAll(); await loadShopping();
      } catch (e) { alert(e.message); }
    };
  });
}
document.getElementById('copy-list').onclick = async () => { const d = window._shopping; if (d) { await navigator.clipboard.writeText(d.items.map(i => `${i.name} — need ${fmt(i.need)} ${i.unit}`).join('\n')); alert('Copied'); } };
document.getElementById('export-csv').onclick = () => window.open('/api/shopping-list.csv', '_blank');
async function loadHistory() {
  const list = await api('/api/history');
  document.getElementById('history-list').innerHTML = list.map(e => `<div class="card"><strong>${e.type === 'bake-complete' ? 'Bake completed' : e.type === 'restock' ? 'Restocked' : 'Stock adjusted'}: ${e.name || ''}</strong><br><span class="hint">${new Date(e.at).toLocaleString('en-SG')}</span><br>${e.type === 'bake-complete' ? `Deducted: ${(e.deducted || []).map(t => `${fmt(t.qty)} ${t.unit} ${t.name}`).join(', ')}${e.ballsAdded ? `, froze ${fmt(e.ballsAdded)} balls` : ''}` : `${fmt(e.before)} to ${fmt(e.after)} ${e.unit || ''}${e.added ? `, added ${fmt(e.added)}` : ''}`}${e.undone ? ' — <span class="warn">undone</span>' : ` <button class="ghost small" onclick="undoHistory('${e.id}')">Undo</button>`}</div>`).join('') || '<p>No stock changes yet.</p>';
}
async function undoHistory(id) {
  if (!confirm('Undo this change? Stock will be put back.')) return;
  await api('/api/history/' + id + '/undo', { method: 'POST' });
  await loadAll(); await loadHistory();
}
document.getElementById('lock-unlock').onclick = unlock;
document.getElementById('lock-password').addEventListener('keydown', e => { if (e.key === 'Enter') unlock(); });
document.getElementById('download-backup').onclick = downloadBackup;
document.getElementById('restore-backup').onchange = e => restoreBackup(e.target.files[0]);
applyTheme();
applyDashboard();
loadAll().catch(() => {}); // a 401 here just shows the lock screen
