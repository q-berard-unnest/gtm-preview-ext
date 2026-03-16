// ============================================================
// service-worker.js — Orchestration centrale (Phase 2)
// ============================================================
// Nouveautés Phase 2 :
//   • Import des modules lib (ES modules)
//   • Évaluation des triggers GTM à chaque push dataLayer
//   • Cache du conteneur parsé (invalidé si le JSON change)
//   • Calcul du dataLayer fusionné pour la résolution des variables
// ============================================================

'use strict';

import { parseContainer } from './lib/gtm-parser.js';
import { TriggerEngine  } from './lib/trigger-engine.js';
import { TagEngine      } from './lib/tag-engine.js';

// ─── Constantes ───────────────────────────────────────────────────────────────

const MAX_EVENTS_PER_TAB = 500;

// ─── État global ──────────────────────────────────────────────────────────────

/** Ports DevTools actifs par tabId @type {Map<number, chrome.runtime.Port>} */
const devtoolsPorts = new Map();

/** Buffer d'événements enrichis par onglet @type {Map<number, Array>} */
const eventsByTab = new Map();

/** Conteneur GTM parsé (cache invalidé sur changement de storage) */
let containerCache = null;

/** Moteur d'évaluation des triggers (cache) */
let engineCache = null;

/** Moteur d'évaluation des tags (cache) */
let tagEngineCache = null;

/** Compteurs de déclenchements ONCE par onglet @type {Map<number, Map<string,number>>} */
const tagFireCountByTab = new Map();

// ─── Gestion du cache du conteneur ───────────────────────────────────────────

/**
 * Retourne le TriggerEngine chargé, ou null si aucun conteneur n'est importé.
 * Charge et parse le conteneur depuis chrome.storage.local si nécessaire.
 * @returns {Promise<TriggerEngine|null>}
 */
async function getEngine() {
  if (engineCache) return engineCache;

  return new Promise((resolve) => {
    chrome.storage.local.get(['gtmContainer'], (result) => {
      if (!result.gtmContainer) {
        resolve(null);
        return;
      }
      try {
        containerCache  = parseContainer(result.gtmContainer);
        engineCache     = new TriggerEngine(containerCache);
        tagEngineCache  = new TagEngine(containerCache);
        console.log(`[GTM Preview] Conteneur parsé : ${containerCache.meta.containerName} — ${containerCache.triggers.size} triggers, ${containerCache.tags.size} tags`);
        resolve(engineCache);
      } catch (e) {
        console.error('[GTM Preview] Erreur parsing conteneur :', e.message);
        resolve(null);
      }
    });
  });
}

/**
 * Invalide le cache du conteneur (appelé quand le JSON change dans le storage).
 */
function resetEngine() {
  containerCache = null;
  engineCache    = null;
  tagEngineCache = null;
  console.log('[GTM Preview] Cache conteneur invalidé');
}

// Invalider le cache quand l'utilisateur importe un nouveau JSON via le popup
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.gtmContainer) {
    resetEngine();
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Reconstitue l'état fusionné du dataLayer depuis le début de la page
 * jusqu'à (mais non compris) l'événement courant.
 * GTM fusionne les pushes successifs dans un état global.
 *
 * @param {Array} events - buffer d'événements de l'onglet
 * @returns {Object}
 */
function buildMergedDataLayer(events) {
  const merged = {};
  for (const event of events) {
    if (event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)) {
      Object.assign(merged, event.payload);
    }
  }
  return merged;
}

/**
 * Transmet un message au DevTools panel de l'onglet donné.
 * Gère silencieusement les ports fermés.
 * @param {number} tabId
 * @param {Object} message
 */
function sendToPanel(tabId, message) {
  const port = devtoolsPorts.get(tabId);
  if (!port) return;
  try {
    port.postMessage(message);
  } catch {
    // Port fermé entre-temps
    devtoolsPorts.delete(tabId);
  }
}

// ─── Gestion asynchrone des messages ─────────────────────────────────────────

/**
 * Traite les messages qui nécessitent async (évaluation des triggers, etc.)
 * Séparé du listener principal pour permettre l'usage de await.
 * @param {Object} message
 * @param {number} tabId
 */
async function handleAsyncMessage(message, tabId) {

  switch (message.type) {

    // ── Nouvel événement dataLayer ──────────────────────────────────────────
    case 'DATALAYER_PUSH': {
      if (!eventsByTab.has(tabId)) eventsByTab.set(tabId, []);
      const events = eventsByTab.get(tabId);

      // État fusionné avant ce push (pour résolution des variables)
      const mergedBeforePush = buildMergedDataLayer(events);

      // Évaluer les triggers si un conteneur est chargé
      let triggerResults = null;
      const engine = await getEngine();
      if (engine) {
        try {
          triggerResults = engine.evaluateAll(
            message.event.payload,
            message.event.pageContext,
            mergedBeforePush
          );
        } catch (e) {
          console.error('[GTM Preview] Erreur évaluation triggers :', e.message);
        }
      }

      // Résoudre toutes les variables si un conteneur est chargé
      let variableValues = null;
      if (engine && containerCache) {
        try {
          variableValues = engine.resolveAllVariables(
            message.event.payload,
            message.event.pageContext,
            mergedBeforePush
          );
        } catch (e) {
          console.error('[GTM Preview] Erreur résolution variables :', e.message);
        }
      }

      // Évaluer les tags si un conteneur est chargé
      let tagResults = null;
      if (tagEngineCache) {
        try {
          const firedCounts = tagFireCountByTab.get(tabId) || new Map();
          const { results, toIncrement } = tagEngineCache.evaluate(triggerResults || [], firedCounts);
          tagResults = results;

          // Mettre à jour les compteurs ONCE
          if (toIncrement.length > 0) {
            if (!tagFireCountByTab.has(tabId)) tagFireCountByTab.set(tabId, new Map());
            const counts = tagFireCountByTab.get(tabId);
            toIncrement.forEach(id => counts.set(id, (counts.get(id) || 0) + 1));
          }
        } catch (e) {
          console.error('[GTM Preview] Erreur évaluation tags :', e.message);
        }
      }

      // Enrichir l'événement avec les résultats
      const enrichedEvent = { ...message.event, triggerResults, variableValues, tagResults };

      // Stocker dans le buffer (avec limite)
      events.push(enrichedEvent);
      if (events.length > MAX_EVENTS_PER_TAB) events.shift();

      // Transmettre au panel
      sendToPanel(tabId, { type: 'DATALAYER_PUSH', event: enrichedEvent });
      break;
    }

    // ── Navigation : réinitialiser le buffer ───────────────────────────────
    case 'PAGE_NAVIGATED': {
      eventsByTab.delete(tabId);
      tagFireCountByTab.delete(tabId);
      sendToPanel(tabId, { type: 'PAGE_NAVIGATED', url: message.url });
      break;
    }

    // ── Content script prêt ────────────────────────────────────────────────
    case 'CONTENT_SCRIPT_READY': {
      sendToPanel(tabId, { type: 'CONTENT_SCRIPT_READY', url: message.url });
      break;
    }
  }
}

// ─── Connexions long-lived (DevTools panel) ───────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'devtools-panel') return;

  let tabId = null;

  port.onMessage.addListener((message) => {
    if (message.type === 'DEVTOOLS_INIT') {
      tabId = message.tabId;
      devtoolsPorts.set(tabId, port);

      // Rejouer l'historique existant (si la page a été chargée avant l'ouverture du panel)
      const existingEvents = eventsByTab.get(tabId) || [];
      if (existingEvents.length > 0) {
        port.postMessage({ type: 'REPLAY_EVENTS', events: existingEvents });
      }
    }

    if (message.type === 'CLEAR_EVENTS' && tabId !== null) {
      eventsByTab.delete(tabId);
    }
  });

  port.onDisconnect.addListener(() => {
    if (tabId !== null) devtoolsPorts.delete(tabId);
  });
});

// ─── Listener principal ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;

  // GET_EXTENSION_STATE est synchrone (sendResponse requis)
  if (message.type === 'GET_EXTENSION_STATE') {
    chrome.storage.local.get(['disabledSites', 'blockedSites'], (result) => {
      const disabledSites = result.disabledSites || [];
      const blockedSites  = result.blockedSites  || {};
      sendResponse({
        enabled: !disabledSites.includes(message.hostname),
        blocked: !!blockedSites[message.hostname],
      });
    });
    return true; // async sendResponse
  }

  // Tous les autres messages sont traités de façon asynchrone
  handleAsyncMessage(message, tabId).catch((e) => {
    console.error('[GTM Preview] Erreur handleAsyncMessage :', e);
  });
  // Pas de sendResponse → pas besoin de return true
});

// ─── Nettoyage ────────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  eventsByTab.delete(tabId);
  tagFireCountByTab.delete(tabId);
  devtoolsPorts.delete(tabId);
});

console.log('[GTM Preview] Service Worker (Phase 2) démarré');
