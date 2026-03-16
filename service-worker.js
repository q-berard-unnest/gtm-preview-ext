// ============================================================
// service-worker.js — Orchestration centrale (Phase 2)
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

/** IDs GTM détectés par onglet @type {Map<number, string[]>} */
const detectedGtmsByTab = new Map();

/** Conteneur GTM parsé (cache invalidé sur changement de storage) */
let containerCache = null;

/** Moteur d'évaluation des triggers (cache) */
let engineCache = null;

/** Moteur d'évaluation des tags (cache) */
let tagEngineCache = null;

/** Compteurs de déclenchements ONCE par onglet @type {Map<number, Map<string,number>>} */
const tagFireCountByTab = new Map();

// ─── Helpers format blockedSites ─────────────────────────────────────────────

/**
 * Normalise une entrée blockedSites (ancienne = number, nouvelle = objet).
 * @param {number|Object|undefined} v
 * @returns {{ ruleId: number, gtmId: string|null, liveMode: boolean }|null}
 */
function normBlockEntry(v) {
  if (!v) return null;
  if (typeof v === 'number') return { ruleId: v, gtmId: null, liveMode: false };
  if (typeof v === 'object') return { ruleId: v.ruleId, gtmId: v.gtmId || null, liveMode: !!v.liveMode };
  return null;
}

/**
 * Construit une règle declarativeNetRequest pour bloquer GTM.
 * Si gtmId est fourni, filtre sur l'URL spécifique de ce conteneur.
 */
function makeDNRRule(ruleId, hostname, gtmId) {
  return {
    id: ruleId,
    priority: 1,
    action: { type: 'block' },
    condition: {
      urlFilter: gtmId
        ? `||googletagmanager.com/gtm.js*id=${gtmId}`
        : '||googletagmanager.com/gtm.js',
      initiatorDomains: [hostname],
      resourceTypes: ['script'],
    },
  };
}

// ─── Résolution de templates pour le mode Live ───────────────────────────────

/**
 * Remplace {{VarName}} dans un template par les valeurs de variableValues.
 * Ignore les marqueurs pageEval (variables client-side non disponibles ici).
 */
function resolveTemplateForLive(template, variableValues) {
  if (!template || !variableValues) return template;
  return template.replace(/\{\{([^}]+)\}\}/g, function(match, varName) {
    const name = varName.trim();
    if (Object.prototype.hasOwnProperty.call(variableValues, name)) {
      const v = variableValues[name];
      if (v && typeof v === 'object' && v.__gtmPreviewPageEval) return '';
      if (v === null || v === undefined) return '';
      return String(v);
    }
    return '';
  });
}

/**
 * Exécute le contenu HTML d'un tag Custom HTML dans le contexte de la page.
 * Cette fonction est sérialisée et exécutée dans world: 'MAIN'.
 */
function executeGtmHtml(html) {
  var temp = document.createElement('div');
  temp.innerHTML = html;
  var scripts = temp.getElementsByTagName('script');
  var toRun = [];
  for (var i = 0; i < scripts.length; i++) {
    toRun.push({ src: scripts[i].src, text: scripts[i].textContent });
  }
  toRun.forEach(function(s) {
    var el = document.createElement('script');
    if (s.src) { el.src = s.src; }
    else        { el.textContent = s.text; }
    document.head.appendChild(el);
    el.remove();
  });
}

// ─── Gestion du cache du conteneur ───────────────────────────────────────────

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

function resetEngine() {
  containerCache = null;
  engineCache    = null;
  tagEngineCache = null;
  console.log('[GTM Preview] Cache conteneur invalidé');
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.gtmContainer) {
    resetEngine();
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildMergedDataLayer(events) {
  const merged = {};
  for (const event of events) {
    if (event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)) {
      Object.assign(merged, event.payload);
    }
  }
  return merged;
}

function sendToPanel(tabId, message) {
  const port = devtoolsPorts.get(tabId);
  if (!port) return;
  try {
    port.postMessage(message);
  } catch {
    devtoolsPorts.delete(tabId);
  }
}

// ─── Mode Live : exécution des tags Custom HTML ───────────────────────────────

/**
 * Si le mode live est activé pour ce site, exécute les tags Custom HTML déclenchés.
 */
function executeLiveHtmlTags(tabId, hostname, tagResults, variableValues) {
  if (!tagResults || !variableValues) return;

  chrome.storage.local.get(['blockedSites'], (result) => {
    const entry = normBlockEntry((result.blockedSites || {})[hostname]);
    if (!entry?.liveMode) return;

    const firedHtmlTags = tagResults.filter(t => t.status === 'FIRED' && t.tagType === 'html');
    for (const tag of firedHtmlTags) {
      const htmlParam = (tag.tagParams || []).find(p => p.key === 'html');
      if (!htmlParam?.value) continue;

      const resolvedHtml = resolveTemplateForLive(htmlParam.value, variableValues);
      chrome.scripting.executeScript({
        target: { tabId },
        world:  'MAIN',
        func:   executeGtmHtml,
        args:   [resolvedHtml],
      }).catch(e => console.warn('[GTM Preview Live] Erreur exécution tag HTML:', e.message));
    }
  });
}

// ─── Gestion asynchrone des messages ─────────────────────────────────────────

async function handleAsyncMessage(message, tabId) {

  switch (message.type) {

    case 'DATALAYER_PUSH': {
      if (!eventsByTab.has(tabId)) eventsByTab.set(tabId, []);
      const events = eventsByTab.get(tabId);

      const mergedBeforePush = buildMergedDataLayer(events);

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

      let tagResults = null;
      if (tagEngineCache) {
        try {
          const firedCounts = tagFireCountByTab.get(tabId) || new Map();
          const { results, toIncrement } = tagEngineCache.evaluate(triggerResults || [], firedCounts);
          tagResults = results;

          if (toIncrement.length > 0) {
            if (!tagFireCountByTab.has(tabId)) tagFireCountByTab.set(tabId, new Map());
            const counts = tagFireCountByTab.get(tabId);
            toIncrement.forEach(id => counts.set(id, (counts.get(id) || 0) + 1));
          }
        } catch (e) {
          console.error('[GTM Preview] Erreur évaluation tags :', e.message);
        }
      }

      // Mode live : exécuter les tags Custom HTML déclenchés
      const hostname = message.event?.pageContext?.pageHostname;
      if (hostname) {
        executeLiveHtmlTags(tabId, hostname, tagResults, variableValues);
      }

      const enrichedEvent = { ...message.event, triggerResults, variableValues, tagResults };

      events.push(enrichedEvent);
      if (events.length > MAX_EVENTS_PER_TAB) events.shift();

      sendToPanel(tabId, { type: 'DATALAYER_PUSH', event: enrichedEvent });
      break;
    }

    case 'PAGE_NAVIGATED': {
      eventsByTab.delete(tabId);
      tagFireCountByTab.delete(tabId);
      sendToPanel(tabId, { type: 'PAGE_NAVIGATED', url: message.url });
      break;
    }

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

  // GET_DETECTED_GTMS : appelé depuis le popup (pas de sender.tab)
  if (message.type === 'GET_DETECTED_GTMS') {
    sendResponse({ ids: detectedGtmsByTab.get(message.tabId) || [] });
    return true;
  }

  const tabId = sender.tab?.id;
  if (tabId === undefined) return;

  // GTM_IDS_DETECTED : pas de réponse nécessaire
  if (message.type === 'GTM_IDS_DETECTED') {
    const existing = detectedGtmsByTab.get(tabId) || [];
    const merged   = [...new Set([...existing, ...(message.ids || [])])];
    detectedGtmsByTab.set(tabId, merged);
    sendToPanel(tabId, { type: 'GTM_IDS_DETECTED', ids: merged });
    return;
  }

  // INJECT_INTO_FRAME : injecter injected.js dans un iframe (ex: Shopify web-pixel-sandbox)
  if (message.type === 'INJECT_INTO_FRAME') {
    const frameId = sender.frameId;
    if (!frameId || !tabId) return;

    const tabUrl = sender.tab?.url;
    if (tabUrl) {
      let tabHostname;
      try { tabHostname = new URL(tabUrl).hostname; } catch { tabHostname = ''; }
      chrome.storage.local.get(['disabledSites'], (result) => {
        const disabledSites = result.disabledSites || [];
        if (disabledSites.includes(tabHostname)) return;
        chrome.scripting.executeScript({
          target: { tabId, frameIds: [frameId] },
          world:  'MAIN',
          files:  ['injected.js'],
        }).catch(e => console.warn('[GTM Preview] Injection iframe échouée :', e.message));
      });
    } else {
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        world:  'MAIN',
        files:  ['injected.js'],
      }).catch(e => console.warn('[GTM Preview] Injection iframe échouée :', e.message));
    }
    return;
  }

  // GET_EXTENSION_STATE est synchrone (sendResponse requis)
  if (message.type === 'GET_EXTENSION_STATE') {
    chrome.storage.local.get(['disabledSites', 'blockedSites'], (result) => {
      const disabledSites = result.disabledSites || [];
      const blockedSites  = result.blockedSites  || {};
      sendResponse({
        enabled: !disabledSites.includes(message.hostname),
        blocked: !!normBlockEntry(blockedSites[message.hostname]),
      });
    });
    return true;
  }

  handleAsyncMessage(message, tabId).catch((e) => {
    console.error('[GTM Preview] Erreur handleAsyncMessage :', e);
  });
});

// ─── Nettoyage ────────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  eventsByTab.delete(tabId);
  tagFireCountByTab.delete(tabId);
  devtoolsPorts.delete(tabId);
  detectedGtmsByTab.delete(tabId);
});

// ─── Resync des règles declarativeNetRequest au démarrage ────────────────────
chrome.storage.local.get(['blockedSites'], (result) => {
  const blockedSites = result.blockedSites || {};
  const entries = Object.entries(blockedSites);
  if (entries.length === 0) return;

  const addRules = entries.map(([hostname, raw]) => {
    const entry = normBlockEntry(raw);
    if (!entry) return null;
    return makeDNRRule(entry.ruleId, hostname, entry.gtmId);
  }).filter(Boolean);

  if (addRules.length === 0) return;

  chrome.declarativeNetRequest.getDynamicRules((existing) => {
    const removeRuleIds = existing.map(r => r.id);
    chrome.declarativeNetRequest.updateDynamicRules(
      { addRules, removeRuleIds },
      () => {
        if (chrome.runtime.lastError) {
          console.warn('[GTM Preview] Resync règles DNR :', chrome.runtime.lastError.message);
        } else {
          console.log(`[GTM Preview] ${addRules.length} règle(s) DNR resynchronisée(s)`);
        }
      }
    );
  });
});

console.log('[GTM Preview] Service Worker démarré');
