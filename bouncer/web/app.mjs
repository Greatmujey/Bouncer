import { RUN, explorerTx, formatUnits, readCurrentBalances, shortId } from './evidence.mjs';
import { setupTour } from './tour.mjs';

setupTour();

// Each workspace destination is its own view, with hash links for deep links,
// refresh and browser Back/Forward. Existing section URLs continue to work.
// Without JavaScript all sections remain readable as a single document.
const routeByHash = Object.freeze({
  '': 'overview', overview: 'overview', capabilities: 'resources',
  'run-story': 'resources', resources: 'resources', guardrails: 'guardrails',
  'how-it-works': 'guardrails', proof: 'proof', 'latest-mission': 'proof',
  roadmap: 'proof', connect: 'connect',
});
const routeNames = Object.freeze({ overview: 'Overview', resources: 'Resources', guardrails: 'Guardrails', proof: 'On-chain proof', connect: 'Wallet & AI' });
const sectionHashes = new Set(['run-story', 'resources', 'how-it-works', 'latest-mission', 'roadmap']);
const navigation = [...document.querySelectorAll('.side-link, .mobile-nav a')];
const routeViews = [...document.querySelectorAll('[data-route-view]')];
function showRoute(initial = false) {
  const hash = location.hash.slice(1);
  // Only our own keys are routes; built-in object properties such as
  // "constructor" must not turn a malformed fragment into a blank view.
  const route = Object.prototype.hasOwnProperty.call(routeByHash, hash) ? routeByHash[hash] : 'overview';
  for (const view of routeViews) view.hidden = view.dataset.routeView !== route;
  for (const link of navigation) {
    const active = routeByHash[link.getAttribute('href').slice(1)] === route;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.querySelector('#route-breadcrumb').textContent = routeNames[route];
  document.title = `${routeNames[route]} · Bouncer`;
  if (!initial) {
    document.querySelector('#route-announcement').textContent = `${routeNames[route]} view`;
    const heading = document.querySelector(`[data-route-view="${route}"] h1`);
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  }
  requestAnimationFrame(() => {
    if (sectionHashes.has(hash)) document.getElementById(hash)?.scrollIntoView({ behavior: 'auto', block: 'start' });
    else if (!initial || hash) window.scrollTo({ top: 0, behavior: 'auto' });
  });
}
window.addEventListener('hashchange', () => showRoute());
showRoute(true);

const grid = document.querySelector('#resource-grid');
const status = document.querySelector('#rpc-status');
const refresh = document.querySelector('#refresh-balances');

function resourceCard(resource) {
  // Values here are fixed constants from evidence.mjs, not untrusted input.
  const card = document.createElement('article');
  card.className = `resource-card ${resource.id}`;
  card.innerHTML = `
    <div class="resource-head"><div class="resource-icon"><svg aria-hidden="true"><use href="#i-${resource.id === 'compute' ? 'cpu' : resource.id}"/></svg></div>
      <div><div class="resource-title">${resource.title}</div><div class="resource-service">${resource.service}</div></div><span class="verified-pill">✓ VERIFIED</span></div>
    <div class="resource-amount">${formatUnits(resource.amount, resource.decimals)} <span>${resource.tokenLabel}</span></div><div class="resource-caption">paid in the recorded run</div>
    <div class="resource-divider"></div>
    <dl class="resource-details"><div><dt>Per-transaction cap</dt><dd>${formatUnits(resource.perTx, resource.decimals)} ${resource.tokenLabel}</dd></div>
      <div><dt>Daily cap</dt><dd>${formatUnits(resource.daily, resource.decimals)} ${resource.tokenLabel}</dd></div>
      <div><dt>Vault balance <span class="balance-label" data-label="${resource.id}">(recorded)</span></dt><dd data-balance="${resource.id}">${formatUnits(resource.vault, resource.decimals)} ${resource.tokenLabel}</dd></div>
      <div><dt>Testnet token</dt><dd title="${resource.token}">${shortId(resource.token, 11, 8)}</dd></div></dl>
    <div class="resource-footer"><span>Development provider</span><a href="${explorerTx(resource.tx)}" target="_blank" rel="noopener noreferrer" aria-label="View ${resource.title} testnet transaction">View transaction <svg aria-hidden="true"><use href="#i-external"/></svg></a></div>`;
  return card;
}
RUN.resources.forEach(resource => grid.append(resourceCard(resource)));

refresh.addEventListener('click', async () => {
  refresh.disabled = true;
  status.className = 'rpc-status';
  status.textContent = 'Checking current recorded vault balances through a public NEAR testnet RPC…';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const balances = await readCurrentBalances(fetch, controller.signal);
    for (const resource of RUN.resources) {
      document.querySelector(`[data-balance="${resource.id}"]`).textContent = `${formatUnits(balances[resource.id], resource.decimals)} ${resource.tokenLabel}`;
      document.querySelector(`[data-label="${resource.id}"]`).textContent = '(current)';
    }
    status.className = 'rpc-status success';
    status.textContent = 'Current recorded vault balances loaded from NEAR testnet. Payments and policy caps above remain the historical run.';
  } catch {
    // Never substitute mock or historical values and call them live.
    for (const resource of RUN.resources) {
      document.querySelector(`[data-balance="${resource.id}"]`).textContent = `${formatUnits(resource.vault, resource.decimals)} ${resource.tokenLabel}`;
      document.querySelector(`[data-label="${resource.id}"]`).textContent = '(recorded)';
    }
    status.className = 'rpc-status error';
    status.textContent = 'Couldn’t reach the public testnet RPC from this browser. Showing the recorded run instead.';
  } finally {
    clearTimeout(timer);
    refresh.disabled = false;
  }
});

// Interactive evidence explorer: these tabs switch between recorded examples;
// clicking them does not place an order, run a job, or send a transaction.
const storyTabs = [...document.querySelectorAll('[data-story-tab]')];
function selectStory(id, focus = false) {
  const resource = RUN.resources.find(item => item.id === id);
  if (!resource) return;
  for (const tab of storyTabs) {
    const active = tab.dataset.storyTab === id;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active && focus) tab.focus();
  }
  document.querySelector('#story-panel').setAttribute('aria-labelledby', `story-tab-${id}`);
  document.querySelector('#story-title').textContent = resource.story.title;
  document.querySelector('#story-request').textContent = resource.story.request;
  document.querySelector('#story-payment').textContent = `${formatUnits(resource.amount, resource.decimals)} ${resource.tokenLabel} on NEAR testnet, within the owner’s rules.`;
  document.querySelector('#story-result').textContent = resource.story.result;
  document.querySelector('#story-transaction').href = explorerTx(resource.tx);
}
for (const link of document.querySelectorAll('[data-resource-story]')) {
  link.addEventListener('click', () => selectStory(link.dataset.resourceStory));
}
for (const [index, tab] of storyTabs.entries()) {
  tab.addEventListener('click', () => selectStory(tab.dataset.storyTab));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % storyTabs.length;
    else if (event.key === 'ArrowLeft') next = (index + storyTabs.length - 1) % storyTabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = storyTabs.length - 1;
    else return;
    event.preventDefault();
    selectStory(storyTabs[next].dataset.storyTab, true);
  });
}
