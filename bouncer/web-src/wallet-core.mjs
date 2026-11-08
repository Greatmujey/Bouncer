import { WALLET_MANIFEST } from './wallet-manifest.mjs';
import { loadVerifiedExecutor } from './wallet-executor.mjs';
import { isTestnetAccount, isWalletConnectProjectId, pairingTopic } from './walletconnect-core.mjs';
import { verifyCliLogin } from './cli-login.mjs';
import { verifyConnectedWalletOwner } from './wallet-owner-verification.mjs';
import { formatPublicAmount, isNearAccountId, readPublicTestnetAccount } from './account-view.mjs';
import { fetchBufferReadinessPreview } from './buffer-readiness-preview.mjs';
import { createWitnessedSetupClient } from './witnessed-setup-client.mjs';
import { createOwnerKeyFallbackFetch } from './read-only-owner-key-fallback.mjs';
import { openNativeOracleDeviceKey } from './native-oracle-device-key.mjs';
import { createNativeOracleSetupClient } from './native-oracle-setup-client.mjs';
import { createNativeOracleOwnerFlow } from './native-oracle-owner-flow.mjs';
import { createDirectOutlayerTest, directOutlayerOriginAllowed } from './direct-outlayer-testnet.mjs';
import { createRemoteDirectFence, directTestCapability } from './direct-test-remote-fence.mjs';

// HTTP Date is coarse and can be cached. Only flag a large discrepancy when
// the response provides a valid Date/Age and the request was reasonably fast.
// This is a local diagnostic, not a source of trusted time or a security check.
export function hasLargeClockSkew(dateHeader, ageHeader, started, finished) {
  const serverTime = Date.parse(dateHeader || '');
  const age = ageHeader == null ? 0 : Number(ageHeader);
  if (!Number.isFinite(serverTime) || !Number.isFinite(age) || age < 0 || age > 86_400 ||
      !Number.isFinite(started) || !Number.isFinite(finished) || finished < started || finished - started > 10_000) return false;
  const expected = serverTime + age * 1000;
  return Math.abs((started + finished) / 2 - expected) > 120_000 + (finished - started) / 2;
}

/** A temporary host with many projects under one origin must never hold a wallet session. */
export function walletOriginAllowed(location, isTopLevel, approvedOrigin = '', remoteFence = null) {
  if (!isTopLevel) return false;
  const { hostname, protocol, origin } = location;
  if (hostname === 'madethis.website' || hostname.endsWith('.madethis.website')) return false;
  // Public GitHub Pages projects owned by the same account share one origin
  // across repository paths, so approving an exact origin would also expose
  // wallet storage to every other project on that origin. Use an isolated
  // custom domain instead, after a separate security review.
  if (hostname === 'github.io' || hostname.endsWith('.github.io')) return false;
  if (['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return protocol === 'http:' || protocol === 'https:';
  if (protocol !== 'https:') return false;
  if (directOutlayerOriginAllowed(origin, isTopLevel, remoteFence) && origin === `https://${hostname}`) return true;
  if (/^[a-z0-9-]+-\d+\.app\.github\.dev$/i.test(hostname)) return true;
  if (/^\d+-[a-z0-9-]+\.e2b\.app$/i.test(hostname)) return true;
  // For a real deployment, the owner can explicitly approve its exact dedicated
  // origin in index.html. Never set this to a shared path-based hosting origin.
  return approvedOrigin !== '' && approvedOrigin === origin;
}

/** Native setup remains hidden unless the same-origin backend opts in. Only
 * the dedicated Bouncer origin and its test preview may offer that flow. */
export function nativeSetupOriginAllowed(location, isTopLevel) {
  if (isTopLevel !== true || location?.protocol !== 'https:') return false;
  if (location.origin === 'https://bouncer-near.vercel.app' && location.hostname === 'bouncer-near.vercel.app') return true;
  return /^4173-[a-z0-9-]+\.e2b\.app$/i.test(location.hostname ?? '') && location.origin === `https://${location.hostname}`;
}

/**
 * NEAR Connect sign-in is identity-only; Ethereum onboarding may request its
 * own approval. The separately gated testnet setup can later ask for explicit
 * wallet transactions and one reviewed trial. A typed account is an unverified
 * public view, not a signer. Mobile and CLI use off-chain login messages;
 * executors are sandboxed and the picker is our own accessible dialog.
 */
export async function initWallet({ window: win, document: doc, NearConnector, SandboxWallet, loadWalletConnect, walletConnectStartTimeoutMs = 50_000 }) {
  const dialog = doc.querySelector('#wallet-dialog');
  const closeButton = doc.querySelector('#wallet-close');
  const optionsBox = doc.querySelector('#wallet-options');
  const options = [...doc.querySelectorAll('[data-wallet-id]')];
  const openers = [...doc.querySelectorAll('[data-wallet-open]')];
  const disconnect = doc.querySelector('#wallet-disconnect');
  const status = doc.querySelector('#wallet-status');
  const dialogStatus = doc.querySelector('#wallet-dialog-status');
  const walletTitle = doc.querySelector('#wallet-title-text');
  const walletDescription = doc.querySelector('#wallet-dialog-description');
  const openSite = doc.querySelector('#wallet-open-site');
  const banner = doc.querySelector('#wallet-banner');
  const wcPanel = doc.querySelector('#walletconnect-pairing');
  const wcCaption = doc.querySelector('#walletconnect-caption');
  const wcBadge = doc.querySelector('#walletconnect-badge');
  const wcQr = doc.querySelector('#walletconnect-qr');
  const wcCanvas = doc.querySelector('#walletconnect-canvas');
  const wcOpen = doc.querySelector('#walletconnect-open');
  const wcCopy = doc.querySelector('#walletconnect-copy');
  const wcCancel = doc.querySelector('#walletconnect-cancel');
  const wcRetry = doc.querySelector('#walletconnect-retry');
  const wcLoading = doc.querySelector('#walletconnect-loading');
  const wcProgress = doc.querySelector('#walletconnect-progress');
  const wcError = doc.querySelector('#walletconnect-error');
  const wcErrorTitle = doc.querySelector('#walletconnect-error-title');
  const wcErrorDetail = doc.querySelector('#walletconnect-error-detail');
  const wcReady = doc.querySelector('#walletconnect-ready');
  const walletSafety = doc.querySelector('#wallet-safety');
  const googlePicker = doc.querySelector('.google-picker');
  const accountEntryPanel = doc.querySelector('#wallet-account-entry');
  const accountForm = doc.querySelector('#wallet-account-form');
  const accountInput = doc.querySelector('#wallet-account-id');
  const accountError = doc.querySelector('#wallet-account-error');
  const accountBack = doc.querySelector('#wallet-account-back');
  const cliVerify = doc.querySelector('#wallet-cli-verify');
  const accountViewPanel = doc.querySelector('#wallet-account-view');
  const accountName = doc.querySelector('#wallet-account-name');
  const accountBadge = doc.querySelector('#wallet-account-badge');
  const accountWarning = doc.querySelector('#wallet-account-warning');
  const accountNear = doc.querySelector('#wallet-account-near');
  const accountUsdc = doc.querySelector('#wallet-account-usdc');
  const accountBalanceStatus = doc.querySelector('#wallet-account-balance-status');
  const accountUseWallet = doc.querySelector('#wallet-account-use-wallet');
  const accountRefresh = doc.querySelector('#wallet-account-refresh');
  const ownerVerify = doc.querySelector('#wallet-owner-verify');
  const ownerStatus = doc.querySelector('#wallet-owner-status');
  const directOpen = doc.querySelector('#wallet-direct-outlayer-open');
  const directPanel = doc.querySelector('#wallet-direct-outlayer-panel');
  const directStatus = doc.querySelector('#wallet-direct-outlayer-status');
  const directHash = doc.querySelector('#wallet-direct-outlayer-hash');
  const directResult = doc.querySelector('#wallet-direct-outlayer-result');
  const directReview = doc.querySelector('#wallet-direct-outlayer-review');
  const directSend = doc.querySelector('#wallet-direct-outlayer-send');
  const directCheck = doc.querySelector('#wallet-direct-outlayer-check');
  const directRecover = doc.querySelector('#wallet-direct-outlayer-recover');
  const directOriginal = doc.querySelector('#wallet-direct-outlayer-original');
  const directRecoverOriginal = doc.querySelector('#wallet-direct-outlayer-recover-original');
  const nativeOpen = doc.querySelector('#wallet-native-setup-open');
  const nativePanel = doc.querySelector('#wallet-native-setup-panel');
  const nativeTerms = doc.querySelector('#wallet-native-setup-terms');
  const nativeStage = doc.querySelector('#wallet-native-setup-stage');
  const nativeStatus = doc.querySelector('#wallet-native-setup-status');
  const nativeHash = doc.querySelector('#wallet-native-setup-hash');
  const nativeCheck = doc.querySelector('#wallet-native-setup-check');
  const nativeDevice = doc.querySelector('#wallet-native-setup-device');
  const nativeReserve = doc.querySelector('#wallet-native-setup-reserve');
  const nativeApprove = doc.querySelector('#wallet-native-setup-approve');
  const nativeReceipt = doc.querySelector('#wallet-native-setup-receipt');
  const nativeVerify = doc.querySelector('#wallet-native-setup-verify');
  const nativeTrialReview = doc.querySelector('#wallet-native-trial-review');
  const nativeTrialSend = doc.querySelector('#wallet-native-trial-send');
  const nativeTrialCheck = doc.querySelector('#wallet-native-trial-check');
  const nativeRecover = doc.querySelector('#wallet-native-setup-recover');
  const nativeOriginal = doc.querySelector('#wallet-native-setup-original');
  const nativeRecoverOriginal = doc.querySelector('#wallet-native-setup-recover-original');
  const bufferReadiness = doc.querySelector('#wallet-buffer-readiness');
  const bufferReadinessStatus = doc.querySelector('#wallet-buffer-readiness-status');
  const bufferSetupStart = doc.querySelector('#wallet-buffer-setup-start');
  const bufferSetupPanel = doc.querySelector('#wallet-buffer-setup-panel');
  const bufferSetupTerms = doc.querySelector('#wallet-buffer-setup-terms');
  const bufferSetupReserve = doc.querySelector('#wallet-buffer-setup-reserve');
  const bufferSetupApprove = doc.querySelector('#wallet-buffer-setup-approve');
  const bufferSetupStatus = doc.querySelector('#wallet-buffer-setup-status');
  const setupRecovery = doc.querySelector('#wallet-setup-recovery');
  const setupRecoveryStatus = doc.querySelector('#wallet-setup-recovery-status');
  const setupRecoveryForm = doc.querySelector('#wallet-setup-recovery-form');
  const setupOriginal = doc.querySelector('#wallet-setup-original');
  const setupCheckOriginal = doc.querySelector('#wallet-setup-check-original');
  const setupRecordOriginal = doc.querySelector('#wallet-setup-record-original');
  const ethereumInfoPanel = doc.querySelector('#wallet-ethereum-info');
  const ethereumContinue = doc.querySelector('#wallet-ethereum-continue');
  const ethereumBack = doc.querySelector('#wallet-ethereum-back');
  if (!dialog || !closeButton || !optionsBox || !options.length || !openers.length || !disconnect || !status || !dialogStatus ||
      !accountEntryPanel || !accountForm || !accountInput || !accountError || !accountBack || !cliVerify || !accountViewPanel ||
      !accountName || !accountBadge || !accountWarning || !accountNear || !accountUsdc || !accountBalanceStatus || !accountUseWallet || !accountRefresh ||
      !ethereumInfoPanel || !ethereumContinue || !ethereumBack) return;

  const approved = doc.querySelector('meta[name="bouncer-wallet-origin"]')?.content || '';
  // Optional hosted-preview CSP nonce is passed to NEAR Connect's isolated
  // wallet iframe; it is not a credential or a wallet authorization.
  const suppliedNonce = doc.querySelector('meta[name="bouncer-csp-nonce"]')?.content || '';
  const cspNonce = /^[A-Za-z0-9+/=]{16,128}$/.test(suppliedNonce) ? suppliedNonce : undefined;
  let isTop = false;
  try { isTop = win.top === win.self; } catch { /* fail closed */ }
  // The temporary hosted route is enabled only after its exact-origin,
  // capability-bound journal answers. A failed or copied link grants nothing.
  let remoteFence = null;
  try {
    const capability = directTestCapability(win.location, win.sessionStorage);
    if (isTop && capability) {
      const candidate = createRemoteDirectFence({origin:win.location.origin,capability,fetch:win.fetch.bind(win)});
      await candidate.read(); remoteFence = candidate;
    }
  } catch { /* fail closed; no wallet prompt */ }
  const previewModeMessage = 'Preview mode: Bouncer spending setup is read-only unless its backend is enabled. Some wallets may request their own setup; review every wallet prompt.';
  const allowedIds = new Set([...WALLET_MANIFEST.wallets.map(wallet => wallet.id), 'wallet-connect']);
  let connector, selectedWallet = null, connected = false, connectedAccount = '', ready = false, busyState = false, opener = null;
  let wcProjectId = '', wcHandle = null, wcAbort = null, wcPairing = false, wcUri = '', wcClockSkew = false;
  // A name-only view never populates selectedWallet, connectedAccount or the
  // connector's session storage. It cannot be used as a wallet or signer.
  let accountEntry = false, ethereumInfo = false, viewedAccount = '', accountRead = null, accountReadVersion = 0;
  // In-memory proof only, bound to the selected session. It never grants
  // spending access, authenticates a backend, or survives account changes.
  let ownerVerification = null, ownerSessionVersion = 0, setupRecoveryAvailable = false, setupRecoverySelection = null, matchedOriginal = null;
  let bufferSetupDraft = null, nativeSetupAvailable = false, nativeFlow = null, nativeSetupOpening = false, directFlow = null;
  const bufferSetupStages = ['create_keyless_vault', 'register_vault_circle', 'fund_vault_circle'];
  let bannerTimer;
  const trusted = new Set(WALLET_MANIFEST.wallets);
  const walletReadFetch = createOwnerKeyFallbackFetch({ fetch:win.fetch.bind(win),
    enabled:nativeSetupOriginAllowed(win.location, true) });
  function setWalletLabels(label) {
    doc.querySelectorAll('[data-wallet-label]').forEach(node => { node.textContent = label; });
  }
  function setStatus(message) { status.textContent = message; dialogStatus.textContent = message; }
  setStatus(previewModeMessage);
  function bufferSetupReviewText(review) {
    const vaultAmount = review.stages?.[0]?.actions?.find(action => action.type === 'transfer')?.deposit_yocto;
    const registrationAmount = review.stages?.[1]?.actions?.[0]?.deposit_yocto;
    const fundingAmount = review.stages?.[2]?.actions?.[0]?.args?.amount;
    if (![vaultAmount, registrationAmount, fundingAmount, review.fixed_product_price_atoms].every(value => typeof value === 'string')) {
      throw new Error('SETUP_REVIEW_UNAVAILABLE');
    }
    return `Vault ${review.vault}. Stage 1 transfers ${formatPublicAmount(vaultAmount, 24)} NEAR and deploys the reviewed keyless contract (SHA-256 ${review.vault_wasm_sha256}); storage funds may remain locked. ` +
      `Stage 2 registers the vault for Circle test USDC with ${formatPublicAmount(registrationAmount, 24)} NEAR. ` +
      `Stage 3 deposits ${formatPublicAmount(fundingAmount, 6)} test USDC into the vault, not to Buffer. ` +
      `The reviewed Buffer product costs ${formatPublicAmount(review.fixed_product_price_atoms, 6)} test USDC and is a separate later payment. ` +
      'Each stage needs its own wallet approval; no order is created here.';
  }
  function renderDirectState(state) {
    if (!state) return;
    if (directStatus) directStatus.textContent = state.message || '';
    if (directHash) { directHash.hidden = !state.originalHash; directHash.textContent = state.originalHash ? `Original transaction: ${state.originalHash}` : ''; }
    if (directResult) {
      directResult.hidden = !state.receipt;
      directResult.textContent = state.receipt ? `Verified direct provider receipt · maximum ${formatPublicAmount(state.receipt.maximum_yocto,24)} test NEAR · charged ${formatPublicAmount(state.receipt.charged_yocto,24)} · refund ${formatPublicAmount(state.receipt.refunded_to_owner_yocto,24)} to your wallet · reported NEAR price $${state.receipt.price_usd}. This did not use Bouncer's firewall.` : '';
    }
    const disabled = busyState || state.busy;
    if (directReview) { directReview.hidden = !['initial','stopped'].includes(state.phase); directReview.disabled = disabled; }
    if (directSend) { directSend.hidden = state.phase !== 'reviewed'; directSend.disabled = disabled; }
    if (directCheck) { directCheck.hidden = state.phase !== 'retained' || !state.originalHash; directCheck.disabled = disabled; }
    if (directRecover) directRecover.hidden = !['unknown','stopped'].includes(state.phase);
    if (directOriginal) directOriginal.disabled = disabled;
    if (directRecoverOriginal) directRecoverOriginal.disabled = disabled;
  }
  function renderNativeState(state) {
    if (!state) return;
    const terms = state.terms;
    if (nativeTerms) nativeTerms.textContent = terms
      ? `Owner: ${terms.owner}\nKeyless vault: ${terms.vault}\nStorage funding: ${terms.storageNear} test NEAR (can remain locked)\nVault deposit: ${terms.depositNear} test NEAR (not a provider payment)\nLimit: ${terms.capNear} test NEAR per request / ${terms.dailyNear} per rolling day\nAgent gas allowance: up to ${terms.gasAllowanceNear} test NEAR\nProvider: ${terms.payee} · project ${terms.project}\nIf unused funds are refunded, they return to the owner; verify the actual receipts. The full maximum counts against the rolling budget. Gas is extra. Each stage needs a separate wallet approval.`
      : '';
    const descriptions = {
      create_compressed_native_vault: `1 of 3 · Create the keyless vault and fund ${terms?.storageNear ?? '—'} test NEAR for storage, then upgrade the small loader to the reviewed contract. The upgrade is asynchronous: failure can leave funds locked until a separate owner refund. This does not pay the provider.`,
      configure_fund_native_oracle: `2 of 3 · Set the spending policy and deposit ${terms?.depositNear ?? '—'} test NEAR into the vault. Four owner-only calls attach 1 yoctoNEAR each. This does not yet pay the provider.`,
      create_configure_fund_native_vault: `1 of 2 · Create and configure the keyless vault, transfer ${terms?.storageNear ?? '—'} test NEAR for storage, and deposit ${terms?.depositNear ?? '—'} test NEAR. Storage can remain locked. Four owner-only calls attach 1 yoctoNEAR each; this does not yet pay the provider.`,
      create_keyless_native_vault: `1 of 4 · Create the keyless vault, transfer ${terms?.storageNear ?? '—'} test NEAR for storage and deploy the reviewed contract. Storage can remain locked.`,
      configure_native_oracle_policy: '2 of 4 · Set the spending limits, allowlisted OutLayer project and restricted agent key. The four owner-only calls attach 1 yoctoNEAR each.',
      fund_native_vault: `3 of 4 · Deposit ${terms?.depositNear ?? '—'} test NEAR into the vault. This is not a provider payment.`,
      install_native_oracle_agent: `${terms?.setupStages === 2 ? '2 of 2' : terms?.setupStages === 3 ? '3 of 3' : '4 of 4'} · Add the restricted agent key with a gas allowance of ${terms?.gasAllowanceNear ?? '—'} test NEAR. It cannot attach the 1 yoctoNEAR required for owner-only changes.`,
    };
    if (nativeStage) nativeStage.textContent = state.phase === 'trial_review'
      ? `One OutLayer NEAR/USD price request · maximum ${terms?.capNear ?? '—'} test NEAR from the vault. The full maximum counts toward the rolling daily limit; unused funds return to the owner only if the refund receipt succeeds. Gas is separate. This is a single-source result, not storage delivery or a guarantee of accuracy.`
      : descriptions[state.stageId] || '';
    if (nativeStatus) nativeStatus.textContent = state.message || '';
    if (nativeHash) { nativeHash.hidden = !state.originalHash; nativeHash.textContent = state.originalHash ? `Original transaction: ${state.originalHash}` : ''; }
    const disabled = busyState || state.busy;
    const buttons = [[nativeCheck, ['initial','stopped','blocked','recover','await_receipt','verify_setup','trial_retained']],
      [nativeDevice, ['create_device']], [nativeReserve, ['review']], [nativeApprove, ['stage']],
      [nativeReceipt, ['await_receipt']], [nativeVerify, ['verify_setup']],
      [nativeTrialReview, ['setup_verified']], [nativeTrialSend, ['trial_review']], [nativeTrialCheck, ['trial_retained']]];
    for (const [button, phases] of buttons) if (button) { button.hidden = !phases.includes(state.phase); button.disabled = disabled; }
    if (nativeTrialReview && !state.trialAvailable) nativeTrialReview.hidden = true;
    if (nativeRecover) nativeRecover.hidden = state.phase !== 'recover';
    if (nativeOriginal) nativeOriginal.disabled = disabled;
    if (nativeRecoverOriginal) nativeRecoverOriginal.disabled = disabled;
  }
  function notify(message, persistent = false) {
    if (!banner) return;
    clearTimeout(bannerTimer);
    banner.textContent = message; banner.hidden = false;
    if (!persistent) {
      bannerTimer = setTimeout(() => { banner.hidden = true; }, 5500);
      bannerTimer?.unref?.();
    }
  }
  function hideBanner() { clearTimeout(bannerTimer); if (banner) banner.hidden = true; }
  function renderControls() {
    const viewing = Boolean(viewedAccount);
    // Rendering must not erase a wallet error or an uncertain onboarding result.
    // The preview explanation is set at initialization, while each operation
    // sets its own status explicitly.
    optionsBox.hidden = connected || wcPairing || accountEntry || ethereumInfo || viewing;
    if (wcPanel) wcPanel.hidden = !wcPairing;
    accountEntryPanel.hidden = !accountEntry;
    accountViewPanel.hidden = !viewing && !connected;
    const ownerVerified = connected && ownerVerification?.wallet === selectedWallet && ownerVerification?.accountId === connectedAccount;
    accountBadge.textContent = ownerVerified ? 'OWNER VERIFIED' : connected ? 'CONNECTED' : 'VIEW ONLY';
    accountWarning.textContent = ownerVerified
      ? 'Your wallet signed an off-chain message and its Full Access key was checked on testnet. This does not approve transactions, create a vault, or grant spending access.'
      : connected ? 'Public balances for the connected testnet account. Connecting alone does not grant Bouncer spending access.'
        : 'Unverified account name. No wallet is connected and no spending access was granted.';
    if (ownerVerify) {
      ownerVerify.hidden = !connected || !selectedWallet?.manifest?.features?.signMessage || !isTestnetAccount(connectedAccount);
      ownerVerify.disabled = busyState;
      ownerVerify.textContent = ownerVerified ? 'Verify account again' : 'Verify account in wallet';
    }
    if (bufferReadiness) {
      const experimentalPreview = /^4173-[a-z0-9-]+\.e2b\.app$/i.test(win.location.hostname);
      bufferReadiness.hidden = !(experimentalPreview && ownerVerified && connectedAccount === 'great_mujey.testnet');
      bufferReadiness.disabled = busyState;
    }
    // This separate user-approved provider test is preview-only. It does not
    // enable the protected Bouncer flow or the public production site.
    const directEnabled = directOutlayerOriginAllowed(win.location.origin,isTop,remoteFence) && win.location.protocol === 'https:' &&
      win.location.origin === `https://${win.location.hostname}` && connected && connectedAccount === 'great_mujey.testnet' && selectedWallet?.manifest?.id === 'meteor-wallet' &&
      selectedWallet?.manifest?.features?.signAndSendTransaction === true;
    if (directOpen) { directOpen.hidden = !directEnabled || Boolean(directFlow); directOpen.disabled = busyState; }
    if (directPanel) directPanel.hidden = !directEnabled || !directFlow;
    if (directFlow) renderDirectState(directFlow.getState());
    const nativeEnabled = nativeSetupAvailable && ownerVerified && connectedAccount === 'great_mujey.testnet';
    if (nativeOpen) { nativeOpen.hidden = !nativeEnabled || Boolean(nativeFlow) || nativeSetupOpening; nativeOpen.disabled = busyState; }
    if (nativePanel) nativePanel.hidden = !nativeEnabled || (!nativeFlow && !nativeSetupOpening);
    if (nativeFlow) renderNativeState(nativeFlow.getState());
    const setupEnabled = setupRecoveryAvailable && ownerVerified && connectedAccount === 'great_mujey.testnet';
    if (bufferSetupStart) { bufferSetupStart.hidden = !setupEnabled; bufferSetupStart.disabled = busyState; }
    if (bufferSetupPanel) bufferSetupPanel.hidden = !setupEnabled || !bufferSetupDraft;
    if (bufferSetupReserve) {
      bufferSetupReserve.hidden = !bufferSetupDraft || bufferSetupDraft.reserved || bufferSetupDraft.stopped;
      bufferSetupReserve.disabled = busyState;
    }
    if (bufferSetupApprove) {
      bufferSetupApprove.hidden = !bufferSetupDraft?.reserved || bufferSetupDraft.stopped || bufferSetupDraft.complete;
      bufferSetupApprove.disabled = busyState;
      const stage = bufferSetupStages[bufferSetupDraft?.stageIndex ?? -1];
      bufferSetupApprove.textContent = stage ? `Approve ${stage.replaceAll('_', ' ')} →` : 'Approve next wallet transaction →';
    }
    if (setupRecovery) {
      setupRecovery.hidden = !(setupRecoveryAvailable && ownerVerified && connectedAccount === 'great_mujey.testnet');
      setupRecovery.disabled = busyState;
    }
    if (setupRecoveryForm) setupRecoveryForm.hidden = !(setupRecoveryAvailable && ownerVerified && setupRecoverySelection);
    if (setupCheckOriginal) setupCheckOriginal.disabled = busyState;
    if (setupRecordOriginal) { setupRecordOriginal.hidden = !matchedOriginal || !setupRecoverySelection; setupRecordOriginal.disabled = busyState; }
    accountUseWallet.hidden = connected;
    ethereumInfoPanel.hidden = !ethereumInfo;
    if (walletSafety) walletSafety.hidden = wcPairing || accountEntry || ethereumInfo || viewing;
    // Keep each focused panel uncluttered. Google is separate and returns
    // when the user goes back to the picker.
    if (googlePicker) googlePicker.hidden = wcPairing || accountEntry || ethereumInfo || viewing;
    dialog.dataset.walletView = wcPairing ? 'pairing' : accountEntry ? 'account-entry' : ethereumInfo ? 'ethereum-info' : viewing ? 'account-view' : connected ? 'connected' : 'options';
    options.forEach(button => {
      const isWc = button.dataset.walletId === 'wallet-connect';
      button.disabled = !ready || busyState || connected || !allowedIds.has(button.dataset.walletId) ||
        (isWc && (!wcProjectId || typeof loadWalletConnect !== 'function' || !wcPanel || !wcQr || !wcCanvas || !wcOpen || !wcCopy || !wcCancel || !wcRetry || !wcLoading || !wcError || !wcReady));
    });
    if (wcCaption) wcCaption.textContent = wcProjectId ? 'NEAR testnet · encrypted fallback' : 'Not configured · Project ID required';
    if (wcBadge) wcBadge.textContent = wcProjectId ? 'CONNECT' : 'SETUP';
    disconnect.hidden = !connected && !viewing; disconnect.disabled = busyState;
    disconnect.textContent = viewing ? 'Remove account' : 'Disconnect wallet';
    if (walletTitle) walletTitle.textContent = connected ? 'Wallet connected' : wcPairing ? 'Connect your wallet'
      : accountEntry ? 'Enter an account' : ethereumInfo ? 'Before you connect' : viewing ? 'Account view' : 'Connect an account';
    if (walletDescription) walletDescription.textContent = connected
      ? 'Your testnet wallet is connected. Google sign-in is separate.'
      : wcPairing ? 'Scan with a NEAR testnet wallet, or open it. Approve and return here.'
        : accountEntry ? 'Choose an account without a terminal. This does not connect a wallet.'
          : ethereumInfo ? 'Please review this wallet’s setup before continuing.'
            : viewing ? 'This public view cannot sign, pay, or prove ownership.'
              : 'Choose a testnet wallet or continue with Google. Connecting does not grant spending access.';
    openers.forEach(button => {
      button.disabled = busyState;
      button.dataset.walletState = connected ? 'connected' : viewing ? 'view-only' : 'disconnected';
      button.setAttribute('aria-label', connected ? `Connected: ${connectedAccount}. Manage accounts`
        : viewing ? `Viewing ${viewedAccount}, unverified. Manage account` : 'Connect wallet or Google account');
    });
  }
  function busy(value) { busyState = value; renderControls(); }
  function clearAccountView() {
    accountReadVersion++;
    ownerSessionVersion++; ownerVerification = null; setupRecoveryAvailable = false; setupRecoverySelection = null; matchedOriginal = null; bufferSetupDraft = null;
    nativeSetupAvailable = false; nativeSetupOpening = false; nativeFlow?.destroy(); nativeFlow = null;
    directFlow?.destroy(); directFlow = null;
    if (directStatus) directStatus.textContent = ''; if (directHash) { directHash.hidden = true; directHash.textContent = ''; }
    if (directResult) { directResult.hidden = true; directResult.textContent = ''; } if (directOriginal) directOriginal.value = '';
    if (nativeTerms) nativeTerms.textContent = ''; if (nativeStage) nativeStage.textContent = '';
    if (nativeStatus) nativeStatus.textContent = ''; if (nativeHash) { nativeHash.hidden = true; nativeHash.textContent = ''; }
    if (nativeOriginal) nativeOriginal.value = '';
    if (ownerStatus) { ownerStatus.hidden = true; ownerStatus.textContent = ''; }
    if (bufferReadinessStatus) { bufferReadinessStatus.hidden = true; bufferReadinessStatus.textContent = ''; }
    if (bufferSetupTerms) bufferSetupTerms.textContent = '';
    if (bufferSetupStatus) bufferSetupStatus.textContent = '';
    if (setupRecoveryStatus) { setupRecoveryStatus.hidden = true; setupRecoveryStatus.textContent = ''; }
    if (setupOriginal) setupOriginal.value = '';
    accountRead?.abort(); accountRead = null;
    accountEntry = false; ethereumInfo = false; viewedAccount = '';
    accountName.textContent = ''; accountNear.textContent = '—'; accountUsdc.textContent = '—';
    accountBalanceStatus.textContent = ''; accountError.hidden = true; accountError.textContent = ''; accountRefresh.disabled = false;
    accountRefresh.textContent = 'Load public balances';
  }
  function prepareConnectedBalance(id) {
    accountName.textContent = id;
    accountBalanceStatus.textContent = 'Tap below to load public testnet balances. No signature is requested.';
  }
  function displayedAccount() { return connected ? connectedAccount : viewedAccount; }
  async function refreshAccountView() {
    const id = displayedAccount();
    if (!id) return;
    const version = ++accountReadVersion;
    accountRead?.abort();
    const controller = new AbortController(); accountRead = controller;
    const timer = setTimeout(() => controller.abort(), 15_000);
    accountNear.textContent = '—'; accountUsdc.textContent = '—';
    accountBalanceStatus.textContent = 'Checking public NEAR testnet balances…';
    accountRefresh.textContent = 'Refresh public balances';
    accountRefresh.disabled = true;
    try {
      const result = await readPublicTestnetAccount(id, { fetch: win.fetch.bind(win), signal: controller.signal });
      if (version !== accountReadVersion || displayedAccount() !== id) return;
      accountUsdc.textContent = formatPublicAmount(result.circle, 6);
      if (!result.exists) {
        accountBalanceStatus.textContent = `No native account found for this exact ID on testnet at final block ${result.blockHeight}. The token ledger is not proof of control or spendability; .near is not changed to .testnet.`;
      } else {
        accountNear.textContent = formatPublicAmount(result.near, 24, 6);
        accountBalanceStatus.textContent = `Public testnet RPC · final block ${result.blockHeight}. Balances can change.`;
      }
    } catch {
      if (version === accountReadVersion && displayedAccount() === id) {
        accountBalanceStatus.textContent = 'Could not load live testnet balances. No balance is being guessed; try refreshing.';
      }
    } finally {
      clearTimeout(timer);
      if (version === accountReadVersion) { accountRead = null; accountRefresh.disabled = false; }
    }
  }
  function showDisconnected(message = 'Choose a testnet wallet to connect.') {
    clearAccountView();
    selectedWallet = null; connected = false; connectedAccount = '';
    if (wcHandle) { const handle = wcHandle; wcHandle = null; void Promise.resolve().then(() => handle.disconnect()).catch(() => {}); }
    setStatus(message); setWalletLabels('Connect wallet'); renderControls();
  }
  function acceptAccounts(wallet, accounts, verifiedBy = '') {
    const id = accounts?.[0]?.accountId;
    const validId = wallet?.manifest?.id === 'ethereum-wallets' ? /^0x[0-9a-f]{40}$/.test(id || '') : isTestnetAccount(id);
    if (!wallet || !(wallet instanceof SandboxWallet) || !trusted.has(wallet.manifest) || !validId ||
        (['near-cli', 'near-mobile'].includes(wallet.manifest.id) && verifiedBy !== wallet.manifest.id)) {
      showDisconnected('The wallet did not return a verified testnet account. No account was connected.');
      void storage.remove('selected-wallet').catch(() => {});
      return false;
    }
    clearAccountView();
    selectedWallet = wallet; connected = true; connectedAccount = id;
    prepareConnectedBalance(id);
    setWalletLabels('Connected');
    const evidence = verifiedBy === 'near-cli' ? 'CLI login verified against testnet'
      : verifiedBy === 'near-mobile' ? 'NEAR Mobile login verified against testnet' : 'wallet-reported';
    setStatus(`Connected: ${id} (${evidence}). No vault or spending access is granted.`);
    renderControls();
    return true;
  }
  function closePicker() {
    if (wcPairing) {
      if (wcAbort) wcAbort.abort('cancelled');
      else { wcPairing = false; clearWalletConnectPairing(); setStatus('Choose a testnet wallet to connect.'); renderControls(); }
    }
    if (dialog.open) dialog.close();
  }
  function openPicker(trigger) {
    if (dialog.open) return;
    opener = trigger || doc.activeElement;
    if (typeof dialog.showModal !== 'function') {
      setStatus('This browser does not support the wallet picker. Try an up-to-date browser.');
      return;
    }
    hideBanner();
    dialog.showModal();
    doc.body?.classList.add('wallet-dialog-open');
    if (typeof win.CustomEvent === 'function') win.dispatchEvent(new win.CustomEvent('bouncer:account-picker-open'));
    (accountEntry ? accountInput : ethereumInfo ? ethereumContinue : viewedAccount ? accountUseWallet : connected ? disconnect : options.find(button => !button.disabled) || closeButton).focus();
  }
  for (const button of openers) {
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', 'wallet-dialog');
    button.addEventListener('click', () => openPicker(button));
  }
  closeButton.addEventListener('click', closePicker);
  dialog.addEventListener('cancel', event => { event.preventDefault(); closePicker(); });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button:not([disabled]), a[href], iframe, summary, input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter(element => !element.closest('[hidden]') && element.getClientRects().length > 0);
    if (!focusable.length) { event.preventDefault(); return; }
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  dialog.addEventListener('close', () => {
    // The browser can queue a close event after an immediately reopened dialog.
    if (dialog.open) return;
    if (wcPairing) wcAbort?.abort();
    doc.body?.classList.remove('wallet-dialog-open');
    if (opener && typeof opener.focus === 'function') opener.focus();
  });
  dialog.addEventListener('click', event => {
    // Only a click on the backdrop closes the sheet, not empty space inside it.
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closePicker();
  });
  renderControls();

  if (!walletOriginAllowed(win.location, isTop, approved, remoteFence)) {
    setStatus('Open Bouncer in a new tab to connect your testnet wallet.');
    if (openSite) {
      // A dedicated development preview can be opened directly; shared or
      // unapproved hosts link to the approved production site instead.
      if (!isTop && walletOriginAllowed(win.location, true, approved) && typeof win.location.href === 'string') {
        openSite.href = win.location.href;
      }
      openSite.hidden = false;
    }
    return;
  }

  // Configuration is a public deployment artifact, loaded only on a trusted
  // top-level origin. It cannot inject code or enable additional networks.
  // Failure leaves just WalletConnect disabled, not the other wallet choices.
  void (async () => {
    try {
      const started = Date.now();
      const response = await win.fetch(new URL('./walletconnect-config.json', win.location.href), {
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return;
      wcClockSkew = hasLargeClockSkew(response.headers?.get?.('date'), response.headers?.get?.('age'), started, Date.now());
      const text = await response.text();
      if (text.length > 256) return;
      const config = JSON.parse(text);
      if (config && typeof config === 'object' && !Array.isArray(config) && Object.keys(config).length === 1 && isWalletConnectProjectId(config.projectId)) {
        wcProjectId = config.projectId;
        renderControls();
      }
    } catch { /* No configured WalletConnect project on this deployment. */ }
  })();

  const prefix = 'bouncer:near-connect:';
  // Keep the connector selection in memory if persistent storage is blocked.
  // Individual wallet executors may still require browser storage.
  const memory = new Map();
  const storage = {
    async get(key) {
      if (key === 'debug-wallets') return null;
      try { return win.localStorage.getItem(prefix + key) ?? memory.get(key) ?? null; }
      catch { return memory.get(key) ?? null; }
    },
    async set(key, value) {
      if (key === 'debug-wallets') return;
      memory.set(key, value);
      try { win.localStorage.setItem(prefix + key, value); } catch { /* session-only */ }
    },
    async remove(key) {
      memory.delete(key);
      try { win.localStorage.removeItem(prefix + key); } catch { /* session-only */ }
    },
  };
  function trimUntrustedWallets() {
    // NEAR Connect also discovers injected/debug/parent-frame wallets. Keep
    // only curated sandbox instances and replace their loader BEFORE any
    // account restoration or sign-in can execute code. This also avoids the
    // shared IndexedDB executor cache and its background fetch race entirely.
    connector.wallets = connector.wallets.filter(wallet => wallet instanceof SandboxWallet && trusted.has(wallet.manifest));
    for (const wallet of connector.wallets) {
      wallet.executor.loadCode = () => loadVerifiedExecutor(wallet.manifest, {
        fetch: win.fetch.bind(win), crypto: win.crypto, location: win.location,
      });
    }
  }
  try {
    connector = new NearConnector({ network: 'testnet', features: { testnet: true },
      autoConnect: false, manifest: WALLET_MANIFEST, storage, cspNonce, providers: { testnet: ['https://test.rpc.fastnear.com'] } });
    // Defense in depth if the connector ever tries its default loader.
    connector.db.getItem = async () => null;
    connector.db.setItem = async () => {};
    connector.on('selector:walletsChanged', trimUntrustedWallets);
    connector.on('wallet:signIn', ({ wallet, accounts }) => {
      if (!wcPairing && !wcHandle) acceptAccounts(wallet, accounts);
    });
    connector.on('wallet:signOut', () => { if (selectedWallet) showDisconnected(); });
    await connector.whenManifestLoaded;
    trimUntrustedWallets();
    ready = true;
    // A CLI account typed in an older version was not verified. Never restore
    // it as connected; CLI and Mobile require a fresh login message each tab.
    const previousWallet = await storage.get('selected-wallet');
    if (previousWallet === 'near-mobile' || previousWallet === 'near-cli') {
      await storage.remove('selected-wallet');
      showDisconnected(`${previousWallet === 'near-cli' ? 'NEAR CLI' : 'NEAR Mobile'} requires a new login message.`);
    } else if (previousWallet) {
      try {
        const { wallet, accounts } = await connector.getConnectedWallet();
        acceptAccounts(wallet, accounts);
      } catch { showDisconnected('Previous wallet session could not be restored. You can connect again.'); }
    } else showDisconnected(previewModeMessage);
    renderControls();
  } catch {
    setStatus('Wallet connector could not initialize. Check browser storage and try reloading.');
    ready = false; renderControls();
    return;
  }

  accountForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!ready || busyState || connected || !accountEntry) return;
    const id = String(accountInput.value || '').trim();
    if (!isNearAccountId(id)) {
      accountError.textContent = 'Enter a valid lowercase NEAR account ID, such as your-name.testnet.';
      accountError.hidden = false; accountInput.focus(); return;
    }
    clearAccountView();
    viewedAccount = id; accountName.textContent = id;
    setWalletLabels('Account view');
    setStatus(`Viewing ${id} on testnet (unverified). No wallet is connected; no spending access was granted.`);
    renderControls(); closePicker();
    notify(`Viewing ${id} on testnet only. A wallet is needed to sign.`);
    void refreshAccountView();
  });
  accountBack.addEventListener('click', () => {
    if (!accountEntry || busyState) return;
    accountEntry = false; accountError.hidden = true; accountError.textContent = '';
    setStatus('Choose a testnet wallet to connect.'); renderControls();
    options.find(button => !button.disabled)?.focus();
  });
  accountUseWallet.addEventListener('click', () => {
    if (!viewedAccount || busyState) return;
    showDisconnected('Choose a wallet to connect. Account-name viewing cannot sign.');
    options.find(button => !button.disabled)?.focus();
  });
  accountRefresh.addEventListener('click', () => { void refreshAccountView(); });
  bufferReadiness?.addEventListener('click', async () => {
    const wallet = selectedWallet, accountId = connectedAccount, version = ownerSessionVersion;
    if (busyState || !connected || accountId !== 'great_mujey.testnet' || ownerVerification?.wallet !== wallet ||
        ownerVerification?.accountId !== accountId) return;
    const stillCurrent = () => connected && selectedWallet === wallet && connectedAccount === accountId && ownerSessionVersion === version;
    busy(true);
    if (bufferReadinessStatus) { bufferReadinessStatus.hidden = false; bufferReadinessStatus.textContent = 'Checking testnet. No transaction will be requested.'; }
    try {
      const result = await fetchBufferReadinessPreview({ fetch: win.fetch.bind(win), onProgress: message => {
        if (stillCurrent() && bufferReadinessStatus) bufferReadinessStatus.textContent = message;
      } });
      if (!stillCurrent()) return;
      const s = result.snapshot, review = result.review;
      if (s?.owner !== accountId || review?.owner !== accountId || review?.signing_or_broadcast_authorized !== false ||
          review?.wallet_approval_obtained !== false || s?.signed !== false || s?.sent !== false) throw new Error('READ_ONLY_UNAVAILABLE');
      const balance = formatPublicAmount(s.owner_circle_atoms, 6), price = formatPublicAmount(review.fixed_product_price_atoms, 6);
      if (bufferReadinessStatus) bufferReadinessStatus.textContent = `Read-only review: ${balance} test USDC observed; Buffer brief ${price} test USDC. ` +
        `The proposed keyless vault needs 6 test NEAR, which may remain locked as storage. No wallet transaction was requested. ` +
        `This is not a purchase or spending permission; a durable one-shot journal and wallet approvals are still required.`;
      setStatus('Testnet setup reviewed. No transaction or purchase has been made.');
    } catch {
      if (stillCurrent() && bufferReadinessStatus) bufferReadinessStatus.textContent = 'The read-only setup check is unavailable. No transaction was requested; nothing was spent.';
    } finally { busy(false); if (stillCurrent()) renderControls(); }
  });
  bufferSetupStart?.addEventListener('click', async () => {
    const wallet = selectedWallet, accountId = connectedAccount, version = ownerSessionVersion, proof = ownerVerification;
    if (busyState || !setupRecoveryAvailable || !connected || accountId !== 'great_mujey.testnet' ||
        proof?.wallet !== wallet || proof.accountId !== accountId) return;
    const stillCurrent = () => connected && selectedWallet === wallet && connectedAccount === accountId &&
      ownerSessionVersion === version && ownerVerification === proof;
    busy(true); bufferSetupDraft = null;
    if (bufferSetupStatus) bufferSetupStatus.textContent = 'Refreshing the testnet snapshot and preparing an unsigned review. No transaction is requested.';
    try {
      const result = await fetchBufferReadinessPreview({ fetch: win.fetch.bind(win), onProgress: message => {
        if (stillCurrent() && bufferSetupStatus) bufferSetupStatus.textContent = message;
      } });
      if (!stillCurrent()) return;
      const { snapshot, review, task_id: taskId } = result;
      if (snapshot?.owner !== accountId || review?.owner !== accountId || review.signing_or_broadcast_authorized !== false ||
          review.wallet_approval_obtained !== false || snapshot.signed !== false || snapshot.sent !== false ||
          !/^[a-f0-9]{32}$/.test(taskId ?? '') || review.stages?.length !== 3) throw new Error('SETUP_REVIEW_UNAVAILABLE');
      const terms = bufferSetupReviewText(review);
      bufferSetupDraft = { review, taskId, identity: null, stageIndex: 0, reserved: false, stopped: false, complete: false };
      if (bufferSetupTerms) bufferSetupTerms.textContent = terms;
      if (bufferSetupStatus) bufferSetupStatus.textContent = 'Review the exact amounts above. The next step signs an off-chain reservation message only; it sends no transaction.';
    } catch {
      if (stillCurrent() && bufferSetupStatus) bufferSetupStatus.textContent = 'A fresh setup review is unavailable. No transaction was requested.';
    } finally { busy(false); if (stillCurrent()) renderControls(); }
  });
  bufferSetupReserve?.addEventListener('click', async () => {
    const wallet = selectedWallet, accountId = connectedAccount, version = ownerSessionVersion, proof = ownerVerification, draft = bufferSetupDraft;
    if (busyState || !setupRecoveryAvailable || !draft || draft.reserved || draft.stopped || !connected ||
        proof?.wallet !== wallet || proof.accountId !== accountId) return;
    const stillCurrent = () => connected && selectedWallet === wallet && connectedAccount === accountId &&
      ownerSessionVersion === version && ownerVerification === proof && bufferSetupDraft === draft;
    let stopWalletPresentation = () => {};
    busy(true); closePicker();
    if (bufferSetupStatus) bufferSetupStatus.textContent = 'Approve the off-chain reservation message in your wallet. This is not a transaction.';
    try {
      if (['near-mobile', 'nightly-wallet', 'ledger'].includes(wallet.manifest.id)) stopWalletPresentation = decorateWalletPopup(wallet.manifest.id);
      const client = createWitnessedSetupClient({ wallet, accountId, ownerPublicKey: proof.publicKey, location: win.location,
        crypto: win.crypto, fetch: walletReadFetch, isCurrent: stillCurrent });
      const reservation = await client.reserve({ taskId: draft.taskId, review: draft.review });
      if (!stillCurrent()) return;
      if (reservation?.status !== 'RESERVED_NOT_CLAIMED' || reservation.execution_authorized !== false || !reservation.identity) throw Error();
      draft.identity = reservation.identity; draft.reserved = true;
      if (bufferSetupStatus) bufferSetupStatus.textContent = 'The exact review is reserved in the database and independent witness. No transaction was sent. Approve only the next stage when ready.';
    } catch {
      if (stillCurrent()) {
        draft.stopped = true;
        if (bufferSetupStatus) bufferSetupStatus.textContent = 'Reservation may have committed without acknowledgement. Stop and use setup recovery; do not reserve or approve again.';
      }
    } finally { stopWalletPresentation(); busy(false); if (stillCurrent()) { renderControls(); hideBanner(); openPicker(opener); } }
  });
  bufferSetupApprove?.addEventListener('click', async () => {
    const wallet = selectedWallet, accountId = connectedAccount, version = ownerSessionVersion, proof = ownerVerification, draft = bufferSetupDraft;
    const stageId = bufferSetupStages[draft?.stageIndex ?? -1];
    if (busyState || !setupRecoveryAvailable || !draft?.reserved || draft.stopped || draft.complete || !stageId ||
        !connected || proof?.wallet !== wallet || proof.accountId !== accountId) return;
    const stillCurrent = () => connected && selectedWallet === wallet && connectedAccount === accountId &&
      ownerSessionVersion === version && ownerVerification === proof && bufferSetupDraft === draft;
    let stopWalletPresentation = () => {};
    busy(true); closePicker();
    if (bufferSetupStatus) bufferSetupStatus.textContent = 'The next wallet prompt is for this one reviewed stage only. The client will record and reconcile its original before enabling another stage.';
    try {
      if (['near-mobile', 'nightly-wallet', 'ledger'].includes(wallet.manifest.id)) stopWalletPresentation = decorateWalletPopup(wallet.manifest.id);
      const client = createWitnessedSetupClient({ wallet, accountId, ownerPublicKey: proof.publicKey, location: win.location,
        crypto: win.crypto, fetch: walletReadFetch, isCurrent: stillCurrent });
      const outcome = await client.approveStage({ identity: draft.identity, review: draft.review, stageId });
      if (!stillCurrent()) return;
      if (outcome?.status !== 'ORIGINAL_HASH_RETURNED' || typeof outcome.original_hash !== 'string' || outcome.do_not_retry !== true) {
        draft.stopped = true;
        if (bufferSetupStatus) bufferSetupStatus.textContent = 'The wallet result is unknown. Do not approve this stage again; use setup recovery to locate and reconcile the original.';
        return;
      }
      const recorded = await client.recordOriginal({ identity: draft.identity, stageId, originalHash: outcome.original_hash });
      if (!stillCurrent() || recorded?.status !== 'ORIGINAL_RECORDED') throw Error();
      const reconciled = await client.reconcile({ identity: draft.identity, stageId, originalHash: outcome.original_hash });
      const expected = stageId === bufferSetupStages[2] ? 'FINAL_FUNDING_RECEIPTS_MATCH' : 'FINAL_SETUP_RECEIPT_MATCH';
      if (!stillCurrent() || reconciled?.status !== expected) throw Error();
      draft.stageIndex++;
      if (draft.stageIndex === bufferSetupStages.length) {
        const funded = await client.verifyFunded({ identity: draft.identity });
        if (!stillCurrent() || funded?.status !== 'READ_ONLY_SETUP_STAGE_PROFILE_MATCH' || funded.spending_unlocked !== false) throw Error();
        draft.complete = true;
        if (bufferSetupStatus) bufferSetupStatus.textContent = 'All three setup transactions were reconciled at FINAL. The vault is funded; spending remains locked. No Buffer order or seller payment was made.';
      } else if (bufferSetupStatus) bufferSetupStatus.textContent = `${stageId.replaceAll('_', ' ')} was reconciled at FINAL. Review the next stage above before approving it.`;
    } catch {
      if (stillCurrent()) {
        draft.stopped = true;
        if (bufferSetupStatus) bufferSetupStatus.textContent = 'This stage may have executed or been recorded without a verified result. Stop and use setup recovery; never approve it again.';
      }
    } finally { stopWalletPresentation(); busy(false); if (stillCurrent()) { renderControls(); hideBanner(); openPicker(opener); } }
  });
  ownerVerify?.addEventListener('click', async () => {
    const wallet = selectedWallet, accountId = connectedAccount, version = ownerSessionVersion;
    if (busyState || !connected || !wallet?.manifest?.features?.signMessage || !isTestnetAccount(accountId)) return;
    const stillCurrent = () => connected && selectedWallet === wallet && connectedAccount === accountId && ownerSessionVersion === version;
    let stopWalletPresentation = () => {};
    busy(true); closePicker();
    setStatus('Approve the identity message in your wallet. Bouncer is not requesting a transaction.');
    notify('Approve the identity message in your wallet. No transaction is requested.', true);
    try {
      if (['near-mobile', 'nightly-wallet', 'ledger'].includes(wallet.manifest.id)) stopWalletPresentation = decorateWalletPopup(wallet.manifest.id);
      let timeout;
      const attempt = verifyConnectedWalletOwner({ wallet, accountId, location: win.location,
        crypto: win.crypto, fetch: walletReadFetch });
      let proof;
      try {
        proof = await Promise.race([attempt, new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('WALLET_OWNER_TIMEOUT')), 90_000);
        })]);
      } finally { clearTimeout(timeout); }
      if (!stillCurrent()) return;
      nativeFlow?.destroy(); nativeFlow = null; nativeSetupOpening = false; nativeSetupAvailable = false;
      ownerVerification = { wallet, accountId: proof.accountId, publicKey: proof.publicKey };
      if (ownerStatus) {
        ownerStatus.hidden = false;
        ownerStatus.textContent = 'Identity verified for this session. This is not spending permission.';
      }
      setStatus(`Verified testnet wallet control for ${accountId}. No vault or spending access is granted.`);
      // Recovery is deliberately optional and only becomes visible when the
      // experimental same-origin backend explicitly advertises it. This never
      // opens a transaction or turns on purchasing.
      if (nativeSetupOriginAllowed(win.location, isTop) && accountId === 'great_mujey.testnet') {
        if (/^4173-[a-z0-9-]+\.e2b\.app$/i.test(win.location.hostname)) {
          const client = createWitnessedSetupClient({ wallet, accountId, ownerPublicKey:proof.publicKey,
            location:win.location, crypto:win.crypto, fetch:walletReadFetch, isCurrent:stillCurrent });
          void client.enabled().then(enabled => { if (stillCurrent()) { setupRecoveryAvailable = enabled; renderControls(); } });
        }
        if (wallet.manifest?.features?.signAndSendTransaction && typeof wallet.signAndSendTransaction === 'function') {
          const currentProof = ownerVerification;
          try {
            const nativeClient = createNativeOracleSetupClient({ wallet, accountId, ownerPublicKey:proof.publicKey,
              deviceStore:{ async inspect() { throw Error('device key not opened'); } }, location:win.location,
              crypto:win.crypto, fetch:walletReadFetch, isTopLevel:isTop, isCurrent:() => stillCurrent() && ownerVerification === currentProof });
            void nativeClient.enabled().then(enabled => {
              if (stillCurrent() && ownerVerification === currentProof) { nativeSetupAvailable = enabled; renderControls(); }
            }).catch(() => {});
          } catch { /* the optional setup must not erase a verified identity */ }
        }
      }
    } catch (error) {
      if (!stillCurrent()) return;
      ownerVerification = null; setupRecoveryAvailable = false; setupRecoverySelection = null; matchedOriginal = null;
      nativeSetupAvailable = false; nativeSetupOpening = false; nativeFlow?.destroy(); nativeFlow = null;
      const reason = error?.message || '';
      const message = reason === 'CLI_ED25519_UNAVAILABLE'
        ? 'This browser cannot verify Ed25519 signatures. Try an up-to-date browser.'
        : reason === 'WALLET_OWNER_TIMEOUT' ? 'The wallet identity request timed out.'
        : reason === 'CLI_RPC_UNAVAILABLE' ? 'Could not check the signing key on testnet. Check your connection and try again.'
          : reason === 'CLI_KEY_NOT_FULL_ACCESS' ? 'The signing key is not a current testnet Full Access key.'
            : 'Identity verification was cancelled or the signed message could not be verified.';
      if (ownerStatus) { ownerStatus.hidden = false; ownerStatus.textContent = `${message} No spending access was granted.`; }
      setStatus(`${message} No spending access was granted.`);
    } finally {
      stopWalletPresentation(); busy(false);
      if (stillCurrent()) { renderControls(); hideBanner(); openPicker(opener); }
    }
  });
  directOpen?.addEventListener('click', async () => {
    const wallet = selectedWallet, accountId = connectedAccount, version = ownerSessionVersion;
    if (busyState || directFlow || !connected || accountId !== 'great_mujey.testnet' || wallet?.manifest?.id !== 'meteor-wallet') return;
    const stillCurrent = () => connected && selectedWallet === wallet && connectedAccount === accountId && ownerSessionVersion === version;
    let flow;
    try {
      const currentFlow = () => stillCurrent() && directFlow === flow;
      flow = createDirectOutlayerTest({wallet,origin:win.location.origin,isTopLevel:isTop,indexedDB:win.indexedDB,
        storage:win.navigator?.storage,remoteFence,fetch:win.fetch.bind(win),isCurrent:currentFlow,
        onChange:state=>{if(currentFlow())renderDirectState(state)}});
      directFlow = flow; renderControls(); busy(true);
      await flow.review();
    } catch {
      if (stillCurrent() && !flow) {
        const message = 'The direct test is unavailable on this browser. No wallet transaction was requested.';
        if (ownerStatus) { ownerStatus.hidden = false; ownerStatus.textContent = message; }
        setStatus(message);
      }
    } finally { busy(false); if (stillCurrent()) renderControls(); }
  });
  const runDirect = async (work, presentWallet = false) => {
    const flow = directFlow;
    if (busyState || !flow) return;
    const stillCurrent = () => directFlow === flow && connected && connectedAccount === 'great_mujey.testnet';
    busy(true);
    if (presentWallet) {
      closePicker();
      setStatus('Review the one direct testnet request in Meteor. Do not repeat it if the result is unknown.');
      notify('Review the direct testnet request in Meteor. No Bouncer firewall is used.', true);
    }
    try { await work(flow); } catch { /* never repeat a wallet request; receipt reads may be checked again */ }
    finally {
      busy(false);
      if (stillCurrent()) { renderControls(); if (presentWallet) { hideBanner(); openPicker(opener); } }
    }
  };
  directReview?.addEventListener('click', () => { void runDirect(flow => flow.review()); });
  directSend?.addEventListener('click', () => { void runDirect(flow => flow.send(), true); });
  directCheck?.addEventListener('click', () => { void runDirect(flow => flow.check()); });
  directRecoverOriginal?.addEventListener('click', () => {
    const original = directOriginal?.value?.trim() || '';
    void runDirect(flow => flow.recover(original));
  });
  nativeOpen?.addEventListener('click', async () => {
    const wallet = selectedWallet, accountId = connectedAccount, version = ownerSessionVersion, proof = ownerVerification;
    if (busyState || !nativeSetupAvailable || nativeFlow || !connected || accountId !== 'great_mujey.testnet' ||
        proof?.wallet !== wallet || proof.accountId !== accountId) return;
    const stillCurrent = () => connected && selectedWallet === wallet && connectedAccount === accountId &&
      ownerSessionVersion === version && ownerVerification === proof;
    let store = null, installed = false;
    nativeSetupOpening = true; busy(true);
    if (nativeStatus) nativeStatus.textContent = 'Checking persistent browser storage and the retained setup. No transaction is requested.';
    try {
      try {
        if (typeof win.navigator?.storage?.persist !== 'function') throw Error('PERSISTENT_STORAGE_UNAVAILABLE');
        // Request on the button gesture; never sign with evictable storage.
        const persistRequest = win.navigator.storage.persist();
        if (!(await persistRequest) && !(await win.navigator.storage.persisted())) throw Error('PERSISTENT_STORAGE_UNAVAILABLE');
        if (!stillCurrent()) return;
        store = await openNativeOracleDeviceKey({ origin:win.location.origin, indexedDB:win.indexedDB,
          crypto:win.crypto, storage:win.navigator.storage, isTopLevel:isTop });
      } catch {
        if (!stillCurrent()) return;
        // Recovery-only: do not treat unavailable storage as an absent key or
        // allow creating/replacing one. Authenticated receipt reads stay useful.
        store = Object.freeze({ async inspect() { return {status:'DEVICE_STORAGE_UNAVAILABLE'}; },
          async create() { throw Error('PERSISTENT_STORAGE_UNAVAILABLE'); }, close() {} });
      }
      if (!stillCurrent()) return;
      let flow;
      const currentFlow = () => stillCurrent() && nativeFlow === flow;
      const client = createNativeOracleSetupClient({ wallet, accountId, ownerPublicKey:proof.publicKey, deviceStore:store,
        location:win.location, crypto:win.crypto, fetch:walletReadFetch, isTopLevel:isTop, isCurrent:currentFlow });
      const interact = async (work, message) => {
        if (!currentFlow()) throw Error('NATIVE_FLOW_SESSION_CHANGED');
        let stopWalletPresentation = () => {};
        closePicker(); setStatus(message); notify(message, true);
        try {
          if (['near-mobile', 'nightly-wallet', 'ledger'].includes(wallet.manifest.id)) stopWalletPresentation = decorateWalletPopup(wallet.manifest.id);
          return await work();
        } finally {
          stopWalletPresentation();
          if (currentFlow()) { hideBanner(); openPicker(opener); }
        }
      };
      flow = createNativeOracleOwnerFlow({ client, deviceStore:store, ownerPublicKey:proof.publicKey, origin:win.location.origin,
        crypto:win.crypto, isCurrent:currentFlow, indexedDB:win.indexedDB, isTopLevel:isTop, fetch:win.fetch.bind(win),
        interact, onChange:state => { if (currentFlow()) renderNativeState(state); } });
      nativeFlow = flow; installed = true; nativeSetupOpening = false; renderControls();
      if (!(await client.enabled()) || !currentFlow()) throw Error('NATIVE_SETUP_UNAVAILABLE');
      await flow.check();
    } catch {
      if (stillCurrent() && !installed) {
        const message = 'Persistent phone storage or native setup is unavailable. No transaction was requested.';
        if (ownerStatus) { ownerStatus.hidden = false; ownerStatus.textContent = message; }
        setStatus(message);
      } else if (stillCurrent() && nativeStatus && nativeFlow?.getState().phase === 'initial') {
        nativeStatus.textContent = 'Native setup is unavailable. No transaction was requested.';
      }
    } finally {
      if (!installed) { try { store?.close(); } catch {} }
      nativeSetupOpening = false; busy(false); if (stillCurrent()) renderControls();
    }
  });
  const runNative = async work => {
    const flow = nativeFlow;
    if (busyState || !flow) return;
    busy(true);
    try { await work(flow); } catch { /* flow remains stopped until original-hash recovery */ }
    finally { busy(false); }
  };
  nativeCheck?.addEventListener('click', () => { void runNative(flow => flow.check()); });
  nativeDevice?.addEventListener('click', () => { void runNative(flow => flow.createDevice()); });
  nativeReserve?.addEventListener('click', () => { void runNative(flow => flow.reserve({ownerConfirmed:true})); });
  nativeApprove?.addEventListener('click', () => { void runNative(flow => flow.approveStage({ownerConfirmed:true})); });
  nativeReceipt?.addEventListener('click', () => { void runNative(flow => flow.checkReceipt()); });
  nativeVerify?.addEventListener('click', () => { void runNative(flow => flow.verifySetup()); });
  nativeTrialReview?.addEventListener('click', () => { void runNative(flow => flow.reviewTrial()); });
  nativeTrialSend?.addEventListener('click', () => { void runNative(flow => flow.runTrial({ownerConfirmed:true})); });
  nativeTrialCheck?.addEventListener('click', () => { void runNative(flow => flow.checkTrial()); });
  nativeRecoverOriginal?.addEventListener('click', () => {
    const hash = nativeOriginal?.value?.trim() || '';
    void runNative(flow => flow.recoverOriginal({hash,ownerConfirmed:true}));
  });
  setupRecovery?.addEventListener('click', async () => {
    const wallet = selectedWallet, accountId = connectedAccount, version = ownerSessionVersion, proof = ownerVerification;
    if (busyState || !setupRecoveryAvailable || !connected || accountId !== 'great_mujey.testnet' ||
        proof?.wallet !== wallet || proof.accountId !== accountId) return;
    const stillCurrent = () => connected && selectedWallet === wallet && connectedAccount === accountId &&
      ownerSessionVersion === version && ownerVerification === proof;
    let stopWalletPresentation = () => {}, timeout;
    busy(true); closePicker();
    setStatus('Approve the recovery identity message. No transaction is requested.');
    notify('Approve the recovery identity message in your wallet. No transaction is requested.', true);
    if (setupRecoveryStatus) { setupRecoveryStatus.hidden = false; setupRecoveryStatus.textContent = 'Checking the retained setup. No transaction is requested.'; }
    try {
      if (['near-mobile', 'nightly-wallet', 'ledger'].includes(wallet.manifest.id)) stopWalletPresentation = decorateWalletPopup(wallet.manifest.id);
      const client = createWitnessedSetupClient({ wallet, accountId, ownerPublicKey:proof.publicKey,
        location:win.location, crypto:win.crypto, fetch:walletReadFetch, isCurrent:stillCurrent,
        onProgress:message => { if (stillCurrent() && setupRecoveryStatus) setupRecoveryStatus.textContent = message; } });
      const result = await Promise.race([client.inspect(), new Promise((_,reject) => {
        timeout = setTimeout(() => reject(new Error('RECOVERY_TIMEOUT')), 120_000);
      })]);
      if (!stillCurrent()) return;
      const last = result?.witnessed_records?.at(-1);
      setupRecoverySelection = result.status === 'WITNESSED' && last?.event === 'claim' && result.identity
        ? { identity:result.identity, review:result.review, stageId:last.stage_id } : null;
      matchedOriginal = null; if (setupOriginal) setupOriginal.value = '';
      if (result.status === 'WITNESSED' && result.identity && result.review && last?.event === 'reserve') {
        bufferSetupDraft = { identity:result.identity, review:result.review, taskId:null, stageIndex:0,
          reserved:true, stopped:false, complete:false };
      } else if (result.status === 'WITNESSED' && result.identity && result.review && last?.event === 'original') {
        const stageIndex = bufferSetupStages.indexOf(last.stage_id);
        const reconciled = await client.reconcile({ identity:result.identity, stageId:last.stage_id, originalHash:last.original_hash });
        const expected = last.stage_id === bufferSetupStages[2] ? 'FINAL_FUNDING_RECEIPTS_MATCH' : 'FINAL_SETUP_RECEIPT_MATCH';
        if (!stillCurrent()) return;
        if (stageIndex < 0 || reconciled?.status !== expected) throw Error();
        bufferSetupDraft = { identity:result.identity, review:result.review, taskId:null, stageIndex:stageIndex + 1,
          reserved:true, stopped:false, complete:false };
        if (bufferSetupDraft.stageIndex === bufferSetupStages.length) {
          const funded = await client.verifyFunded({ identity:result.identity });
          if (!stillCurrent() || funded?.status !== 'READ_ONLY_SETUP_STAGE_PROFILE_MATCH' || funded.spending_unlocked !== false) throw Error();
          bufferSetupDraft.complete = true;
        }
      }
      if (bufferSetupDraft?.review && bufferSetupTerms) bufferSetupTerms.textContent = bufferSetupReviewText(bufferSetupDraft.review);
      const message = result.status === 'NO_LOCAL_RECORD'
        ? 'No setup is recorded in this witness. That does not prove there was no prompt elsewhere. No transaction was requested.'
        : result.status === 'RECOVERY_REQUIRED'
          ? 'The database record is missing but a witness remains. Do not repeat a prompt or transaction.'
          : last?.event === 'claim'
            ? `The ${last.stage_id} prompt was claimed but no original hash is recorded. Do not repeat it. Check wallet history for the original.`
            : last?.event === 'original'
              ? bufferSetupDraft?.complete ? 'All setup originals are reconciled at FINAL. The vault is funded; spending remains locked.'
                : `Witnessed ${last.stage_id} original: ${last.original_hash}. It was reconciled before any next stage. Do not resend it.`
              : last?.event === 'reserve'
                ? 'The witnessed setup reservation was restored. No wallet transaction was sent; you may review and approve stage 1.'
              : 'A setup reservation is recorded. No transaction or delivery is verified.';
      if (setupRecoveryStatus) setupRecoveryStatus.textContent = message;
      setStatus('Recovery check complete. No transaction was requested.');
    } catch {
      if (stillCurrent()) {
        if (setupRecoveryStatus) setupRecoveryStatus.textContent = 'Recovery could not be checked. Do not repeat an uncertain wallet prompt or transaction.';
        setStatus('Recovery check unavailable. No transaction was requested.');
      }
    } finally {
      clearTimeout(timeout); stopWalletPresentation(); busy(false);
      if (stillCurrent()) { renderControls(); hideBanner(); openPicker(opener); }
    }
  });
  setupOriginal?.addEventListener('input', () => { matchedOriginal = null; renderControls(); });
  setupCheckOriginal?.addEventListener('click', async () => {
    const wallet = selectedWallet, accountId = connectedAccount, version = ownerSessionVersion, proof = ownerVerification;
    const selection = setupRecoverySelection, originalHash = setupOriginal?.value?.trim() || '';
    if (busyState || !setupRecoveryAvailable || !selection || !proof || proof.wallet !== wallet ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(originalHash)) {
      if (setupRecoveryStatus) setupRecoveryStatus.textContent = 'Paste the original transaction hash from your wallet history. Do not submit another transaction.';
      return;
    }
    const stillCurrent = () => connected && selectedWallet === wallet && connectedAccount === accountId &&
      ownerSessionVersion === version && ownerVerification === proof && setupRecoverySelection === selection;
    let stopWalletPresentation = () => {}, timeout;
    matchedOriginal = null; busy(true); closePicker();
    setStatus('Approve the off-chain original-check message. No transaction is requested.');
    notify('Approve the original-check message. No transaction is requested.', true);
    try {
      if (['near-mobile', 'nightly-wallet', 'ledger'].includes(wallet.manifest.id)) stopWalletPresentation = decorateWalletPopup(wallet.manifest.id);
      const client = createWitnessedSetupClient({wallet,accountId,ownerPublicKey:proof.publicKey,location:win.location,
        crypto:win.crypto,fetch:walletReadFetch,isCurrent:stillCurrent,
        onProgress:message => { if (stillCurrent() && setupRecoveryStatus) setupRecoveryStatus.textContent = message; }});
      const result = await Promise.race([client.previewOriginal({stageId:selection.stageId,originalHash}), new Promise((_,reject) => {
        timeout = setTimeout(() => reject(new Error('RECOVERY_TIMEOUT')), 120_000);
      })]);
      if (!stillCurrent() || setupOriginal?.value?.trim() !== originalHash) return;
      if (!['FINAL_SETUP_RECEIPT_MATCH','FINAL_FUNDING_RECEIPTS_MATCH','FINAL_FAILURE_NEEDS_RECONCILIATION'].includes(result?.status) ||
          result.tx_hash !== originalHash || result.stage_id !== selection.stageId || result.original_recorded !== false) throw Error();
      matchedOriginal = { ...selection, originalHash };
      if (setupRecoveryStatus) setupRecoveryStatus.textContent = result.status === 'FINAL_FAILURE_NEEDS_RECONCILIATION'
        ? `Original ${originalHash} matches a FINAL failure. Do not resend. Record it for recovery; state still needs inspection.`
        : `Original ${originalHash} matches the reviewed testnet receipt. No payment or delivery is proven. Record this exact hash for recovery.`;
      setStatus('Original checked. No transaction was requested.');
    } catch {
      if (stillCurrent() && setupRecoveryStatus) setupRecoveryStatus.textContent = 'The original could not be verified yet. Keep the hash and do not retry the wallet transaction.';
    } finally {
      clearTimeout(timeout); stopWalletPresentation(); busy(false);
      if (stillCurrent()) { renderControls(); hideBanner(); openPicker(opener); }
    }
  });
  setupRecordOriginal?.addEventListener('click', async () => {
    const wallet = selectedWallet, accountId = connectedAccount, version = ownerSessionVersion, proof = ownerVerification;
    const selected = matchedOriginal;
    if (busyState || !setupRecoveryAvailable || !selected || !proof || proof.wallet !== wallet ||
        setupOriginal?.value?.trim() !== selected.originalHash || setupRecoverySelection?.identity !== selected.identity ||
        setupRecoverySelection?.stageId !== selected.stageId) return;
    const sameSession = () => connected && selectedWallet === wallet && connectedAccount === accountId &&
      ownerSessionVersion === version && ownerVerification === proof;
    const stillCurrent = () => sameSession() && matchedOriginal === selected;
    let stopWalletPresentation = () => {}, timeout;
    busy(true); closePicker();
    setStatus('Approve the off-chain hash-recording message. No transaction is requested.');
    notify('Approve the hash-recording message. No transaction is requested.', true);
    try {
      if (['near-mobile', 'nightly-wallet', 'ledger'].includes(wallet.manifest.id)) stopWalletPresentation = decorateWalletPopup(wallet.manifest.id);
      const client = createWitnessedSetupClient({wallet,accountId,ownerPublicKey:proof.publicKey,location:win.location,
        crypto:win.crypto,fetch:walletReadFetch,isCurrent:stillCurrent,
        onProgress:message => { if (stillCurrent() && setupRecoveryStatus) setupRecoveryStatus.textContent = message; }});
      const result = await Promise.race([client.recordOriginal(selected), new Promise((_,reject) => {
        timeout = setTimeout(() => reject(new Error('RECOVERY_TIMEOUT')), 120_000);
      })]);
      if (!stillCurrent()) return;
      if (result?.status !== 'ORIGINAL_RECORDED' || result.original_hash !== selected.originalHash || result.stage_id !== selected.stageId) throw Error();
      const stageIndex = bufferSetupStages.indexOf(selected.stageId);
      const reconciled = await client.reconcile({ identity:selected.identity, stageId:selected.stageId, originalHash:selected.originalHash });
      const expected = selected.stageId === bufferSetupStages[2] ? 'FINAL_FUNDING_RECEIPTS_MATCH' : 'FINAL_SETUP_RECEIPT_MATCH';
      if (!stillCurrent() || stageIndex < 0 || reconciled?.status !== expected) throw Error();
      bufferSetupDraft = { identity:selected.identity, review:selected.review, taskId:null, stageIndex:stageIndex + 1,
        reserved:true, stopped:false, complete:false };
      if (bufferSetupTerms) bufferSetupTerms.textContent = bufferSetupReviewText(selected.review);
      if (bufferSetupDraft.stageIndex === bufferSetupStages.length) {
        const funded = await client.verifyFunded({ identity:selected.identity });
        if (!stillCurrent() || funded?.status !== 'READ_ONLY_SETUP_STAGE_PROFILE_MATCH' || funded.spending_unlocked !== false) throw Error();
        bufferSetupDraft.complete = true;
      }
      const message = bufferSetupDraft.complete
        ? 'All setup originals are reconciled at FINAL. The vault is funded; spending remains locked.'
        : `Original ${selected.originalHash} was reconciled at FINAL. Review the next setup stage before approving it.`;
      if (setupRecoveryStatus) setupRecoveryStatus.textContent = message;
      if (bufferSetupStatus) bufferSetupStatus.textContent = message;
      matchedOriginal = null; setupRecoverySelection = null;
      setStatus('Original reconciled. No transaction was requested.');
    } catch {
      if (stillCurrent()) {
        matchedOriginal = null;
        if (setupRecoveryStatus) setupRecoveryStatus.textContent = 'Recording may have completed without an acknowledgement. Check setup recovery again; do not resend the transaction.';
      }
    } finally {
      clearTimeout(timeout); stopWalletPresentation(); busy(false);
      if (sameSession()) { renderControls(); hideBanner(); openPicker(opener); }
    }
  });
  // Verified CLI login remains available as an explicit, optional path.
  cliVerify.addEventListener('click', async () => { if (accountEntry && !busyState) await startWallet('near-cli'); });
  ethereumBack.addEventListener('click', () => {
    if (!ethereumInfo || busyState) return;
    ethereumInfo = false; setStatus('Choose a testnet wallet to connect.'); renderControls();
    options.find(button => !button.disabled)?.focus();
  });
  ethereumContinue.addEventListener('click', async () => {
    if (ethereumInfo && !busyState) await startWallet('ethereum-wallets');
  });

  function clearWalletConnectPairing() {
    wcUri = '';
    if (wcOpen) { wcOpen.hidden = true; wcOpen.removeAttribute('href'); }
    if (wcCopy) { wcCopy.hidden = true; wcCopy.textContent = 'Copy pairing link'; }
    if (wcQr) wcQr.hidden = true;
    if (wcReady) wcReady.hidden = true;
    try { wcCanvas?.getContext('2d')?.clearRect(0, 0, wcCanvas.width, wcCanvas.height); } catch { /* canvas is optional in tests */ }
  }
  function walletConnectStage(stage, title = '', detail = '') {
    if (wcPanel) wcPanel.dataset.state = stage;
    if (wcLoading) wcLoading.hidden = stage !== 'loading';
    if (wcError) wcError.hidden = stage !== 'error' && stage !== 'qr-error';
    if (wcRetry) wcRetry.hidden = stage !== 'error';
    if (wcReady) wcReady.hidden = stage !== 'ready';
    if (stage === 'error' || stage === 'qr-error') {
      if (wcErrorTitle) wcErrorTitle.textContent = title;
      if (wcErrorDetail) wcErrorDetail.textContent = detail;
    }
  }
  function backToWallets() {
    wcPairing = false; clearWalletConnectPairing();
    setStatus('Choose a testnet wallet to connect.');
    renderControls();
    if (dialog.open) options.find(button => button.dataset.walletId === 'wallet-connect')?.focus();
  }
  wcCancel?.addEventListener('click', () => {
    if (wcAbort) wcAbort.abort('cancelled');
    else backToWallets();
  });
  wcRetry?.addEventListener('click', async () => { if (!wcAbort && !busyState) await openWalletConnect(); });
  wcCopy?.addEventListener('click', async () => {
    if (!wcUri) return;
    try {
      if (!win.navigator?.clipboard?.writeText) throw new Error('clipboard unavailable');
      await win.navigator.clipboard.writeText(wcUri);
      wcCopy.textContent = 'Copied ✓';
      setStatus('Pairing code copied. Share it only with your wallet app.');
    } catch {
      wcCopy.textContent = 'Copy unavailable';
      setStatus('Copy is unavailable here. Scan the code or open your wallet app.');
    }
  });
  async function openWalletConnect() {
    if (!wcProjectId || typeof loadWalletConnect !== 'function' || wcAbort || busyState || connected) return;
    const controller = new AbortController();
    wcAbort = controller; wcPairing = true;
    clearWalletConnectPairing(); walletConnectStage('loading');
    if (wcProgress) wcProgress.textContent = 'Preparing your WalletConnect pairing. This can take up to a minute.';
    busy(true); setStatus('Preparing a private WalletConnect pairing…');
    if (dialog.open) wcCancel?.focus();
    let startTimedOut = false, shown = false, abortListener, phase = 'sdk';
    let thisHandle = null, endedBeforeHandle = false;
    const cancelled = new Promise((_, reject) => {
      abortListener = () => reject(new Error('cancelled'));
      controller.signal.addEventListener('abort', abortListener, { once: true });
    });
    // Bound both the bundle download and relay setup. A stalled import used to
    // wait forever, and the relay could leave an empty view for two minutes.
    const startTimer = setTimeout(() => { startTimedOut = true; controller.abort('timeout'); }, walletConnectStartTimeoutMs);
    const slowTimer = setTimeout(() => {
      if (!controller.signal.aborted && !shown && wcAbort === controller) {
        if (wcProgress) wcProgress.textContent = 'Taking longer than usual. Still trying to reach WalletConnect…';
        setStatus('Still preparing the WalletConnect QR…');
      }
    }, Math.min(8_000, Math.floor(walletConnectStartTimeoutMs / 2)));
    try {
      const module = await Promise.race([Promise.resolve().then(() => loadWalletConnect({ signal: controller.signal })), cancelled]);
      if (controller.signal.aborted) throw new Error('cancelled');
      phase = 'relay';
      if (wcProgress) wcProgress.textContent = 'Connecting to the WalletConnect relay…';
      const connecting = Promise.resolve().then(() => module.connect({
        projectId: wcProjectId, origin: win.location.origin, signal: controller.signal,
        onProgress: stage => {
          if (!controller.signal.aborted && !shown && wcAbort === controller) {
            if (stage === 'alternate') {
              if (wcProgress) wcProgress.textContent = 'Trying WalletConnect’s alternate relay…';
              setStatus('Trying the alternate WalletConnect relay…');
            } else if (stage === 'bridge') {
              if (wcProgress) wcProgress.textContent = 'Trying Bouncer’s encrypted relay fallback…';
              setStatus('Trying Bouncer’s encrypted relay fallback…');
            }
          }
        },
        onUri: async uri => {
          if (controller.signal.aborted || wcAbort !== controller) return;
          pairingTopic(uri); // Never put an unvalidated link in the DOM.
          clearTimeout(startTimer); clearTimeout(slowTimer); shown = true;
          wcUri = uri;
          wcOpen.setAttribute('href', uri); wcOpen.hidden = false; wcCopy.hidden = false;
          if (wcProgress) wcProgress.textContent = 'Pairing ready. Drawing your QR code…';
          setStatus('Pairing ready. Drawing the QR code…');
          // Render off-DOM so a cancelled or late attempt cannot paint over a
          // subsequent attempt's QR with an expired, different pairing URI.
          const canvas = doc.createElement('canvas');
          let renderTimer;
          try {
            const rendering = Promise.resolve().then(() => module.renderPairingCode(canvas, uri));
            const renderTimeout = new Promise((_, reject) => { renderTimer = setTimeout(() => reject(new Error('QR rendering timed out')), 5_000); });
            await Promise.race([rendering, renderTimeout, cancelled]);
            if (controller.signal.aborted || wcAbort !== controller) return;
            if (!canvas.width || !canvas.height) throw new Error('QR rendering failed');
            wcCanvas.width = canvas.width; wcCanvas.height = canvas.height;
            const context = wcCanvas.getContext('2d');
            if (!context) throw new Error('QR rendering failed');
            context.drawImage(canvas, 0, 0);
            wcQr.hidden = false; walletConnectStage('ready');
            setStatus('Waiting for approval in your NEAR testnet wallet…');
          } catch {
            if (controller.signal.aborted || wcAbort !== controller) return;
            const message = 'The pairing is ready, but the QR could not be drawn. Open your wallet app or copy the link below.';
            walletConnectStage('qr-error', 'QR display unavailable', message);
            setStatus(message);
          } finally { clearTimeout(renderTimer); }
        },
        onEnded: message => {
          // A revocation can arrive while approval is resolving. It must not
          // become a stale Connected state, or clear a newer session.
          if (!thisHandle) { if (wcAbort === controller) endedBeforeHandle = true; return; }
          if (wcHandle !== thisHandle) return;
          wcHandle = null; showDisconnected(message); notify(message);
        },
      }));
      // Even if the SDK or a renderer finishes after timeout/cancellation,
      // disconnect a late approved session instead of accepting it.
      connecting.then(late => {
        if ((controller.signal.aborted || wcAbort !== controller) && typeof late?.disconnect === 'function') {
          void Promise.resolve().then(() => late.disconnect()).catch(() => {});
        }
      }, () => {});
      const handle = await Promise.race([connecting, cancelled]);
      thisHandle = handle;
      if (controller.signal.aborted) { await handle.disconnect(); showDisconnected('WalletConnect pairing cancelled.'); return; }
      if (endedBeforeHandle) { await handle.disconnect(); throw new Error('WalletConnect session ended before connection'); }
      if (!isTestnetAccount(handle.accountId)) { await handle.disconnect(); throw new Error('invalid account'); }
      clearAccountView();
      wcHandle = handle; selectedWallet = null; connected = true; connectedAccount = handle.accountId; wcPairing = false;
      prepareConnectedBalance(handle.accountId);
      setWalletLabels('Connected');
      setStatus(`Connected: ${handle.accountId} (wallet-reported). No vault or spending access is granted.`);
      closePicker(); notify('Testnet account connected. No spending access was granted.');
    } catch (error) {
      if (controller.signal.aborted && !startTimedOut) {
        wcPairing = false;
        showDisconnected('WalletConnect pairing cancelled.');
      } else {
        clearWalletConnectPairing();
        const reason = String(error?.message || '');
        const configurationRejected = error?.code === 'WC_CONFIGURATION';
        let title = 'Pairing could not be prepared', message;
        if (shown) {
          title = 'Connection not completed';
          message = /timed out/i.test(reason)
            ? 'The pairing expired before approval. Generate a new QR and try again. Code WC-APPROVAL.'
            : 'The wallet did not approve this account-only NEAR testnet connection. Try another compatible wallet. Code WC-APPROVAL.';
        } else if (phase === 'sdk') {
          title = 'WalletConnect couldn’t load';
          message = 'The WalletConnect component could not load. Check your connection and retry, or choose another wallet. Code WC-LOAD.';
        } else if (configurationRejected) {
          message = 'WalletConnect rejected the connection. Check your device’s date and time, or choose another wallet. Code WC-CONFIG.';
        } else if (win.navigator?.onLine === false) {
          message = 'Your browser reports that it is offline. Reconnect and retry. Code WC-OFFLINE.';
        } else if (!win.crypto?.getRandomValues || !win.crypto?.subtle) {
          message = 'This browser cannot provide the required secure cryptography. Use an up-to-date browser over HTTPS. Code WC-CRYPTO.';
        } else if (wcClockSkew) {
          message = 'Your device clock may be out of sync. Enable automatic date and time, then retry. Code WC-CLOCK.';
        } else if (error?.code === 'WC_CLIENT_INIT') {
          message = 'The WalletConnect component could not initialize. Reload the page or try another wallet. Code WC-INIT.';
        } else if (error?.code === 'WC_PROPOSAL_INIT') {
          message = 'WalletConnect could not prepare the pairing. Check your connection, then retry or choose another wallet. Code WC-PAIR.';
        } else if (startTimedOut || error?.code === 'WC_START_TIMEOUT') {
          message = 'WalletConnect could not prepare a pairing in time. Check your connection or try another network. Code WC-TIMEOUT.';
        } else {
          message = 'WalletConnect could not prepare a pairing. Check your connection or try another wallet. Code WC-START.';
        }
        walletConnectStage('error', title, message);
        showDisconnected(message);
      }
    } finally {
      clearTimeout(startTimer); clearTimeout(slowTimer);
      controller.signal.removeEventListener('abort', abortListener);
      if (wcAbort === controller) wcAbort = null;
      if (!wcPairing) clearWalletConnectPairing();
      busy(false);
      if (wcPairing && wcError && !wcError.hidden && dialog.open) wcRetry?.focus();
    }
  }

  // Mobile, Nightly and Ledger's sandbox popups can lack a visible close control.
  // The parent-side cancel invokes the existing rejection handler; it never
  // approves a request, signs a message or sends a transaction.
  function decorateWalletPopup(walletId) {
    const mobile = walletId === 'near-mobile';
    if (mobile) doc.body?.classList.add('near-mobile-active');
    if (!win.MutationObserver || !doc.body) return () => { if (mobile) doc.body?.classList.remove('near-mobile-active'); };
    const observer = new win.MutationObserver(() => {
      const root = [...doc.querySelectorAll('.hot-connector-popup')].find(node => node.style.display !== 'none' && node.querySelector('iframe'));
      const content = root?.querySelector('.modal-content');
      const backdrop = root?.querySelector('.modal-container');
      const className = mobile ? 'bouncer-mobile-close' : 'bouncer-wallet-close';
      if (!content || !backdrop || content.querySelector(`.${className}`)) return;
      const cancel = doc.createElement('button');
      cancel.type = 'button'; cancel.className = className;
      const label = mobile ? 'NEAR Mobile' : walletId === 'ledger' ? 'Ledger' : 'Nightly Wallet';
      cancel.setAttribute('aria-label', `Cancel ${label} connection`);
      cancel.textContent = '×';
      cancel.addEventListener('click', () => backdrop.click());
      content.appendChild(cancel);
    });
    observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    return () => { observer.disconnect(); if (mobile) doc.body?.classList.remove('near-mobile-active'); };
  }

  async function startWallet(walletId) {
      if (!ready || busyState || connected || viewedAccount || !allowedIds.has(walletId)) return;
      if (walletId === 'wallet-connect') { await openWalletConnect(); return; }
      accountEntry = false; ethereumInfo = false;
      const name = WALLET_MANIFEST.wallets.find(wallet => wallet.id === walletId).name;
      const mobile = walletId === 'near-mobile', cli = walletId === 'near-cli', ethereum = walletId === 'ethereum-wallets';
      busy(true);
      const opening = mobile
        ? 'NEAR Mobile: approve a login message only. No access key or payment is requested.'
        : cli ? 'NEAR CLI: enter your testnet account, then sign the login message in your terminal.'
          : ethereum ? 'Opening Ethereum Wallets on testnet. The wallet may request a setup transaction.'
            : `Opening ${name} on testnet…`;
      setStatus(opening); notify(opening, true);
      // The NEAR Connect executor uses its own iframe overlay. A native dialog
      // is in the top layer, so close ours before opening the wallet UI.
      closePicker();
      let reopen = false, stopWalletPresentation = () => {};
      try {
        trimUntrustedWallets();
        if (mobile) {
          stopWalletPresentation = decorateWalletPopup(walletId);
          // Upstream NEAR Mobile signIn requests an AddKey transaction (and
          // can request FullAccess). Never call it or its key-deleting signOut.
          // A fresh NEP-413 signature identifies the account without an on-chain
          // action. The pinned adapter verifies the signature and testnet key.
          const wallet = connector.wallets.find(candidate => candidate.manifest.id === walletId);
          if (!wallet || !win.crypto?.getRandomValues) throw new Error('NEAR Mobile unavailable');
          const nonce = win.crypto.getRandomValues(new Uint8Array(32));
          const result = await wallet.signMessage({
            network: 'testnet', nonce,
            recipient: win.location.host,
            message: `Connect to Bouncer on NEAR testnet.\n\nThis login message does not approve a transaction, transfer funds, or add an access key.\n\nSite: ${win.location.origin}`,
          });
          if (!result?.signature || !result?.publicKey) throw new Error('No signed login message returned');
          if (!isTestnetAccount(result.accountId)) throw new Error('MOBILE_TESTNET_REQUIRED');
          acceptAccounts(wallet, [{ accountId: result.accountId }], 'near-mobile');
        } else if (cli) {
          // CLI's ordinary signIn accepts any typed name. Ask for a fresh,
          // off-chain NEP-413 signature instead, with no AddKey parameters.
          // Clear its local-only saved choice so a retry can use another ID.
          const wallet = connector.wallets.find(candidate => candidate.manifest.id === walletId);
          if (!wallet || !win.crypto?.getRandomValues) throw new Error('NEAR CLI unavailable');
          await wallet.executor.clearStorage();
          const nonce = win.crypto.getRandomValues(new Uint8Array(32));
          const recipient = win.location.host;
          const message = `Connect to Bouncer on NEAR testnet.\n\nThis login message does not approve a transaction, transfer funds, or add an access key.\n\nSite: ${win.location.origin}`;
          const accounts = await wallet.signInAndSignMessage({ network: 'testnet', messageParams: { message, nonce, recipient } });
          const account = accounts?.[0];
          await verifyCliLogin({ account, message, nonce, recipient, crypto: win.crypto, fetch: walletReadFetch });
          acceptAccounts(wallet, [account], 'near-cli');
        } else {
          if (walletId === 'nightly-wallet' || walletId === 'ledger') stopWalletPresentation = decorateWalletPopup(walletId);
          if (walletId === 'intear-wallet') {
            // Intear's app-session protocol needs native WebCrypto Ed25519.
            // Fail clearly on older browsers rather than opening a broken UI.
            try { await win.crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']); }
            catch { throw new Error('INTEAR_ED25519_UNAVAILABLE'); }
          }
          // Explicit choice; Bouncer supplies no addFunctionCallKey. The
          // Ethereum provider may independently request relayer onboarding in
          // its approval page, as disclosed before opening it.
          await connector.connect({ walletId });
        }
        if (!connected) {
          await storage.remove('selected-wallet');
          if (!/did not return a verified testnet account/.test(status.textContent)) showDisconnected('No valid testnet account was returned.');
          reopen = true;
        } else notify(`Connected: ${connectedAccount}. No spending access was granted.`);
      } catch (error) {
        await storage.remove('selected-wallet');
        const reason = typeof error === 'string' ? error : error?.message || '';
        const ethereumHash = ethereum ? reason.match(/0x[0-9a-fA-F]{64}/)?.[0] : '';
        showDisconnected(ethereum
          ? `Ethereum wallet connection did not finish. Setup may have been submitted; do not retry until ${ethereumHash ? `original transaction ${ethereumHash}` : 'the original transaction'} is identified and reconciled.`
          : reason === 'INTEAR_ED25519_UNAVAILABLE'
          ? 'Intear needs a newer browser with Ed25519 support. No transaction was sent.'
          : reason === 'CLI_ED25519_UNAVAILABLE'
            ? 'NEAR CLI login needs a newer browser with Ed25519 support. No transaction was sent.'
            : reason === 'CLI_RPC_UNAVAILABLE'
              ? 'Could not check your CLI public key on testnet. Check your connection and try again.'
              : reason === 'CLI_KEY_NOT_FULL_ACCESS'
                ? 'The CLI signing key is not a current Full Access key on this testnet account. No transaction was sent.'
                : cli && /Invalid CLI/.test(reason)
                  ? 'Could not verify the CLI login message. Check the account and paste the complete signed output.'
                  : mobile && reason === 'MOBILE_TESTNET_REQUIRED'
                    ? 'NEAR Mobile did not return a testnet account. Switch the wallet to testnet and try again.'
                    : mobile && /invalid message signature|without a signature|No signed login message/i.test(reason)
                      ? 'Could not verify the NEAR Mobile login message. No account was connected.'
                      : mobile && /full access key/i.test(reason)
                        ? 'The NEAR Mobile signing key could not be verified as a testnet Full Access key. No account was connected.'
                        : mobile && /backend request (failed|timed out)|RPC request failed|RPC error/i.test(reason)
                          ? 'NEAR Mobile or the testnet key check is unavailable. Check your connection and retry.'
                          : 'Wallet connection was cancelled or unavailable. No transaction was sent.');
        reopen = true;
      } finally {
        stopWalletPresentation();
        busy(false);
        if (reopen) { hideBanner(); openPicker(opener); }
      }
  }
  for (const button of options) {
    button.addEventListener('click', async () => {
      const walletId = button.dataset.walletId;
      if (!ready || busyState || connected || viewedAccount || !allowedIds.has(walletId)) return;
      if (walletId === 'near-cli') {
        accountEntry = true; accountInput.value = ''; accountError.hidden = true; accountError.textContent = '';
        setStatus('Enter an account ID for a public testnet view. No terminal or wallet is required.');
        renderControls(); accountInput.focus(); return;
      }
      if (walletId === 'ethereum-wallets') {
        ethereumInfo = true;
        setStatus('Ethereum Wallets may request a one-time testnet setup transaction.');
        renderControls(); ethereumContinue.focus(); return;
      }
      await startWallet(walletId);
    });
  }
  disconnect.addEventListener('click', async () => {
    if (busyState) return;
    if (viewedAccount) { showDisconnected('Account view removed.'); return; }
    if (!selectedWallet && !wcHandle) return;
    busy(true); setStatus('Disconnecting your wallet…');
    try {
      if (wcHandle) {
        const handle = wcHandle; wcHandle = null;
        await handle.disconnect(); // WalletConnect protocol only, never near_signOut.
      } else if (selectedWallet.manifest.id === 'near-mobile') {
        // Message-only sessions are intentionally not persisted and must not
        // call the adapter's signOut, which can request a DeleteKey transaction.
        await storage.remove('selected-wallet');
      } else await connector.disconnect(selectedWallet);
      showDisconnected('Wallet disconnected.');
    } catch {
      if (!selectedWallet && !wcHandle) showDisconnected('Session cleared locally. If it remains in your wallet, disconnect it there.');
      else setStatus('Could not disconnect. Please try again in your wallet.');
    } finally { busy(false); }
  });
}
