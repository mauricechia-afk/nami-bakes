// Nami Bakes frontend. All data comes from the server API (/api/*).
// Nothing about stock/recipes is stored in localStorage.
const api = (p, opts) => fetch(p, opts).then(async r => { const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { raw: t }; } if (!r.ok) throw new Error(j.error || t); return j; });
const fmt = n => { const r = Math.round((Number(n) + Number.EPSILON) * 1000) / 1000; return String(r); };
let ingredients = [], recipes = [], plans = [];

document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  document.querySelectorAll('nav button').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  document.getElementById('tab-' + b.dataset.tab).classList.add('active');
  if (b.dataset.tab === 'shopping') loadShopping();
  if (b.dataset.tab === 'planning') loadPlans();
});

async function loadAll() {
  ingredients = await api('/api/inventory');
  recipes = await api('/api/recipes');
  renderInventory(); renderRecipes(); renderPlanLines();
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
  const body = { name: document.getElementById('new-recipe-name').value, description: document.getElementById('new-recipe-desc').value, yields: Number(document.getElementById('new-recipe-yields').value) || 1, yieldUnit: document.getElementById('new-recipe-yield-unit').value || 'portions', ingredients: ings };
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
      <label>Bought <input type="number" class="restock-amount" value="${fmt(i.need)}" min="0" step="any" style="width:100px"></label>
      <select class="restock-unit">${units.map(u => `<option value="${u.unit}" data-per-unit="${u.perUnit}" ${u.unit === i.unit ? 'selected' : ''}>${u.label}</option>`).join('')}</select>
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
        const r = await api('/api/restock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ingredientId: item.ingredientId, amount, unit }) });
        alert(`Added ${fmt(r.added)} ${r.unit} of ${r.name}. Stock is now ${fmt(r.after)} ${r.unit}.`);
        await loadAll(); await loadShopping();
      } catch (e) { alert(e.message); }
    };
  });
}
document.getElementById('copy-list').onclick = async () => { const d = window._shopping; if (d) { await navigator.clipboard.writeText(d.items.map(i => `${i.name} — need ${fmt(i.need)} ${i.unit}`).join('\n')); alert('Copied'); } };
document.getElementById('export-csv').onclick = () => window.open('/api/shopping-list.csv', '_blank');
loadAll();
