// ============================================================
// content-script.js — Pont entre la page et le service worker
// ============================================================
// Rôle :
//   • Vérifier si l'extension est activée pour ce site
//   • Injecter injected.js dans le contexte de la page (accès à window)
//   • Écouter les messages postMessage depuis injected.js
//   • Relayer les événements dataLayer vers le service worker
//   • Détecter les navigations (SPA inclus) et notifier
// ============================================================

'use strict';

// ─── État local ───────────────────────────────────────────────────────────────

/** Indique si le script injecté a déjà été ajouté */
let injected = false;

/** URL courante (pour détecter les navigations SPA) */
let currentUrl = window.location.href;

// ─── Vérification de l'état d'activation ──────────────────────────────────────

/**
 * Interroge le service worker pour savoir si l'extension est activée
 * pour le hostname courant.
 * @returns {Promise<boolean>}
 */
function checkEnabled() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'GET_EXTENSION_STATE', hostname: window.location.hostname },
      (response) => {
        if (chrome.runtime.lastError) {
          // En cas d'erreur (service worker indisponible), activer par défaut
          resolve({ enabled: true, blocked: false });
          return;
        }
        resolve({
          enabled: response?.enabled !== false,
          blocked: response?.blocked === true,
        });
      }
    );
  });
}

/**
 * Injecte un script inline pour signaler à la page que GTM est bloqué.
 * Doit être appelé AVANT injectPageScript() pour que injected.js le lise.
 */
function injectBlockModeFlag() {
  const script = document.createElement('script');
  script.textContent = 'window.__gtmPreviewBlockMode = true;';
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

// ─── Injection du script dans le contexte page ────────────────────────────────

/**
 * Injecte injected.js dans le contexte window de la page.
 * Cette injection est nécessaire pour accéder au vrai window.dataLayer
 * (les content scripts ont un contexte isolé).
 */
function injectPageScript() {
  if (injected) return;
  injected = true;

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected.js');
  // Nettoyage du tag <script> après exécution
  script.onload = () => script.remove();
  script.onerror = () => {
    console.error('[GTM Preview] Échec de l\'injection de injected.js');
    script.remove();
  };

  // Insérer dès que possible (document_start → documentElement existe toujours)
  (document.head || document.documentElement).appendChild(script);
}

// ─── Écoute des messages depuis injected.js ───────────────────────────────────

/**
 * Relaie les événements dataLayer au service worker.
 * Filtre strictement les messages provenant de notre script injecté.
 */
window.addEventListener('message', (event) => {
  // Sécurité : ignorer les messages d'autres origines ou d'autres scripts
  if (event.source !== window) return;
  if (!event.data || event.data.source !== 'gtm-preview-injected') return;

  if (event.data.type === 'DATALAYER_PUSH') {
    chrome.runtime.sendMessage({
      type: 'DATALAYER_PUSH',
      event: {
        id:          event.data.id,
        timestamp:   event.data.timestamp,
        payload:     event.data.payload,
        index:       event.data.index,
        isInitial:   event.data.isInitial   || false,
        pageContext: event.data.pageContext  || null
      }
    }).catch(() => {
      // Ignorer si le service worker est temporairement indisponible (MV3)
    });
  }

  if (event.data.type === 'GTM_IDS_DETECTED') {
    chrome.runtime.sendMessage({
      type: 'GTM_IDS_DETECTED',
      ids:  event.data.ids || [],
    }).catch(() => {});
  }
});

// ─── Détection des navigations SPA ───────────────────────────────────────────

/**
 * Surveille les changements d'URL pour les Single Page Applications
 * qui utilisent l'History API (pushState / replaceState).
 */
function watchSpaNavigation() {
  const originalPushState    = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);

  function onNavigation(newUrl) {
    if (newUrl !== currentUrl) {
      currentUrl = newUrl;
      notifyNavigation(newUrl);
    }
  }

  history.pushState = function(...args) {
    const result = originalPushState(...args);
    onNavigation(window.location.href);
    return result;
  };

  history.replaceState = function(...args) {
    const result = originalReplaceState(...args);
    onNavigation(window.location.href);
    return result;
  };

  window.addEventListener('popstate', () => {
    onNavigation(window.location.href);
  });
}

/**
 * Notifie le service worker d'une navigation.
 * @param {string} url
 */
function notifyNavigation(url) {
  chrome.runtime.sendMessage({
    type: 'PAGE_NAVIGATED',
    url: url
  }).catch(() => {});
}

// ─── Initialisation ───────────────────────────────────────────────────────────

async function init() {
  // Shopify web-pixel-sandbox frames : injection via service worker (bypass CSP)
  const isWebPixelFrame = typeof window.name === 'string' && window.name.startsWith('web-pixel-sandbox');
  if (isWebPixelFrame) {
    chrome.runtime.sendMessage({ type: 'INJECT_INTO_FRAME' }).catch(() => {});
    return;
  }

  // Dans les autres iframes (non web-pixel) : ne rien faire
  if (window !== window.top) return;

  const { enabled, blocked } = await checkEnabled();
  if (!enabled) return;

  // Notifier le service worker que le content script est actif
  chrome.runtime.sendMessage({
    type: 'CONTENT_SCRIPT_READY',
    url: window.location.href,
    blocked,
  }).catch(() => {});

  // En mode blocage : signaler à la page avant d'injecter le hook
  if (blocked) {
    injectBlockModeFlag();
  }

  // Injecter le hook dataLayer dans le contexte page
  injectPageScript();

  // Surveiller les navigations SPA
  watchSpaNavigation();
}

// Démarrage immédiat (run_at: document_start)
init();
