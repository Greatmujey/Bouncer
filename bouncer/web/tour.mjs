// A short first-visit orientation. It never signs in or starts an agent.
const steps = [
  {
    kicker: 'WELCOME TO BOUNCER', title: 'Meet your resource agent.',
    description: 'Bouncer helps an agent get compute, storage and API services while your on-chain rules guard its spending.',
    callout: 'A local model can propose tasks in a separate test. Financial authority stays with the owner; this is not an open marketplace.',
  },
  {
    kicker: 'SEE THE WHOLE JOURNEY', title: 'From a need to a result.',
    description: 'A request gets a quote, passes policy checks, pays on NEAR testnet, and is fulfilled and verified.',
    callout: 'The latest independent price execution and three resource examples are recorded results, not new orders.',
  },
  {
    kicker: 'YOU STAY IN CONTROL', title: 'Your account, your rules.',
    description: 'Connect a testnet wallet or sign in with Google. Bouncer spending setup is separate; some wallets may request their own setup transaction.',
    callout: 'The contract requires exactly 1 yoctoNEAR for owner-only policy changes. Never share a private key or seed phrase.',
  },
  {
    kicker: 'BRING AN ASSISTANT', title: 'Connect through MCP.',
    description: 'Compatible MCP clients can inspect policies and preview quotes using the local Bouncer server—without signing or paying.',
    callout: 'A hosted connection for web AI apps is still to be built. The model planner runs separately; this website does not run purchases.',
  },
];

export function setupTour(doc = document, storage) {
  if (!storage) { try { storage = globalThis.localStorage; } catch { /* storage is optional */ } }
  const dialog = doc.querySelector('#welcome-tour');
  if (!dialog || typeof dialog.showModal !== 'function') return;
  const title = doc.querySelector('#tour-title'), description = doc.querySelector('#tour-description');
  const kicker = doc.querySelector('#tour-kicker'), callout = doc.querySelector('#tour-callout');
  const count = doc.querySelector('#tour-count'), back = doc.querySelector('#tour-back'), next = doc.querySelector('#tour-next');
  const dots = [...doc.querySelectorAll('.tour-progress span')];
  let index = 0, opener;
  function render() {
    const step = steps[index];
    title.textContent = step.title; description.textContent = step.description;
    kicker.textContent = step.kicker; callout.textContent = step.callout;
    count.textContent = `STEP ${index + 1} OF ${steps.length}`;
    back.disabled = index === 0;
    next.textContent = index === steps.length - 1 ? 'Finish tour' : 'Next →';
    dots.forEach((dot, i) => dot.classList.toggle('active', i <= index));
  }
  function open(openerElement) {
    if (dialog.open) return;
    opener = openerElement; index = 0; render(); dialog.showModal();
    next.focus();
  }
  function close() {
    try { storage?.setItem('bouncer:tour:v1', 'seen'); } catch { /* optional preference */ }
    dialog.close();
    if (opener && typeof opener.focus === 'function') opener.focus();
  }
  doc.querySelectorAll('[data-open-tour]').forEach(button => button.addEventListener('click', () => open(button)));
  doc.querySelector('#tour-skip').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button:not([disabled]), a[href], select:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) { event.preventDefault(); return; }
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  back.addEventListener('click', () => { if (index > 0) { index--; render(); } });
  next.addEventListener('click', () => { if (index === steps.length - 1) close(); else { index++; render(); } });
  // Orientation is available on demand, without interrupting the first visit
  // or blocking the account form behind a modal.
}
