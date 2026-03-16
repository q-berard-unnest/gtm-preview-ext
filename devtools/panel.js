// ============================================================
// panel.js — Logique du DevTools Panel GTM Preview
// ============================================================
// Rôle :
//   • Se connecter au service worker via un port long-lived
//   • Recevoir et afficher la timeline des événements dataLayer
//   • Gérer la sélection / le détail d'un événement
//   • Afficher le dataLayer fusionné à chaque point dans le temps
//   • Gestion du filtre, du clear, du redimensionnement
// ============================================================

'use strict';

// ─── État du panel ────────────────────────────────────────────────────────────

/** Liste de tous les événements reçus (ordre chronologique) */
const allEvents = [];

/** L'événement actuellement sélectionné */
let selectedEventId = null;

/** Port de connexion au service worker */
let swPort = null;

/** Filtre texte courant */
let filterText = '';

/** tabId de l'onglet inspecté */
const tabId = chrome.devtools.inspectedWindow.tabId;

// ─── Références DOM ───────────────────────────────────────────────────────────

const eventsList      = document.getElementById('events-list');
const eventsCount     = document.getElementById('events-count');
const emptyState      = document.getElementById('empty-state');
const searchInput     = document.getElementById('search-input');
const btnClear        = document.getElementById('btn-clear');
const statusDot       = document.getElementById('status-dot');
const statusLabel     = document.getElementById('status-label');
const statusbarText   = document.getElementById('statusbar-text');
const containerInfo   = document.getElementById('container-info');
const badgeMode       = document.getElementById('badge-mode');

// Détail
const detailPlaceholder = document.getElementById('detail-placeholder');
const detailContent     = document.getElementById('detail-content');
const detailEventBadge  = document.getElementById('detail-event-badge');
const detailEventName   = document.getElementById('detail-event-name');
const detailTimestamp   = document.getElementById('detail-timestamp');
const detailIndex       = document.getElementById('detail-index');
const jsonPush          = document.getElementById('json-push');
const jsonDataLayer     = document.getElementById('json-datalayer');

// Onglets détail
const detailTabs      = document.querySelectorAll('.detail-tab');
const tabPush         = document.getElementById('tab-push');
const tabDL           = document.getElementById('tab-datalayer');
const tabTagsBtn      = document.getElementById('tab-tags-btn');
const tabTriggerBtn   = document.getElementById('tab-triggers-btn');
const tabVariablesBtn = document.getElementById('tab-variables-btn');
const triggerResults  = document.getElementById('trigger-results');
const tagsList        = document.getElementById('tags-list');
const variablesList   = document.getElementById('variables-list');
const varSearch       = document.getElementById('var-search');
const btnReeval       = document.getElementById('btn-reeval');
const btnExport       = document.getElementById('btn-export');
const btnCopyPush     = document.getElementById('btn-copy-push');
const btnCopyDL       = document.getElementById('btn-copy-datalayer');
const tagSearch       = document.getElementById('tag-search');

// Redimensionnement
const eventsPanel = document.querySelector('.events-panel');
const resizer     = document.getElementById('resizer');

// ─── Connexion au service worker ─────────────────────────────────────────────

/**
 * Établit (ou rétablit) la connexion long-lived avec le service worker.
 * Reconnecte automatiquement en cas de déconnexion (service worker MV3 peut s'endormir).
 */
function connectToServiceWorker() {
  setStatus('waiting', 'Connexion…');

  try {
    swPort = chrome.runtime.connect({ name: 'devtools-panel' });
  } catch (e) {
    setStatus('disconnected', 'Déconnecté');
    setTimeout(connectToServiceWorker, 2000);
    return;
  }

  // S'identifier auprès du service worker avec notre tabId
  swPort.postMessage({ type: 'DEVTOOLS_INIT', tabId });

  swPort.onMessage.addListener(handleServiceWorkerMessage);

  swPort.onDisconnect.addListener(() => {
    setStatus('disconnected', 'Déconnecté');
    swPort = null;
    // Tentative de reconnexion après 1 seconde
    setTimeout(connectToServiceWorker, 1000);
  });

  setStatus('connected', 'Connecté');
}

// ─── Gestion des messages entrants ───────────────────────────────────────────

/**
 * Traite les messages reçus depuis le service worker.
 * @param {Object} message
 */
function handleServiceWorkerMessage(message) {
  switch (message.type) {

    // Replay de l'historique (panel ouvert après navigation)
    case 'REPLAY_EVENTS':
      message.events.forEach(event => addEvent(event, false));
      setStatusBar(`${allEvents.length} événement(s) chargé(s) depuis l'historique`);
      break;

    // Nouvel événement dataLayer
    case 'DATALAYER_PUSH':
      addEvent(message.event, true);
      break;

    // Nouvelle navigation (page complète ou SPA)
    case 'PAGE_NAVIGATED':
      insertNavigationSeparator(message.url);
      setStatusBar(`Navigation : ${message.url}`);
      break;

    // Le content script est actif sur la page
    case 'CONTENT_SCRIPT_READY':
      setStatus('connected', message.blocked ? 'Actif · GTM bloqué' : 'Actif sur la page');
      setStatusBar(`Monitoring actif : ${message.url}`);
      updateBlockBadge(message.blocked);
      break;
  }
}

// ─── Gestion du statut ────────────────────────────────────────────────────────

/**
 * Met à jour l'indicateur de statut dans la toolbar.
 * @param {'connected'|'disconnected'|'waiting'} state
 * @param {string} label
 */
function setStatus(state, label) {
  statusDot.className = `status-dot ${state}`;
  statusLabel.textContent = label;
}

/**
 * Met à jour le texte de la barre de statut en bas.
 * @param {string} text
 */
function setStatusBar(text) {
  statusbarText.textContent = text;
}

/**
 * Met à jour le badge de mode (Dry-run / GTM bloqué).
 * @param {boolean} blocked
 */
function updateBlockBadge(blocked) {
  if (!badgeMode) return;
  badgeMode.textContent  = blocked ? 'GTM bloqué' : 'Dry-run';
  badgeMode.className    = 'badge badge--mode' + (blocked ? ' badge--blocked' : '');
}

/**
 * Lit l'état de blocage depuis le storage pour l'onglet inspecté
 * et met à jour le badge (utile si le panel s'ouvre après la page).
 */
function loadBlockedState() {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab?.url) return;
    let hostname;
    try { hostname = new URL(tab.url).hostname; } catch { return; }
    chrome.storage.local.get(['blockedSites'], (result) => {
      const blocked = !!(result.blockedSites || {})[hostname];
      updateBlockBadge(blocked);
    });
  });
}

// ─── Ajout d'événements ───────────────────────────────────────────────────────

/**
 * Ajoute un événement dataLayer à la liste et rafraîchit l'UI.
 * @param {Object}  event    - Objet événement depuis le service worker
 * @param {boolean} animate  - true = ajouter avec animation (nouvel event live)
 */
function addEvent(event, animate) {
  allEvents.push(event);
  updateEventsCount();

  // Construire et insérer l'élément DOM dans la liste
  const item = buildEventItem(event);
  if (animate) {
    item.classList.add('event-item--new');
    setTimeout(() => {
      item.classList.remove('event-item--new');
      item.classList.add('event-item--flash');
      setTimeout(() => item.classList.remove('event-item--flash'), 800);
    }, 150);
  }

  // Appliquer le filtre courant
  applyFilterToItem(item, getEventLabel(event));

  eventsList.appendChild(item);
  emptyState.hidden = true;

  // Auto-scroll vers le bas si on était déjà en bas
  const list = eventsList;
  const isAtBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 20;
  if (isAtBottom) {
    list.scrollTop = list.scrollHeight;
  }
}

/**
 * Insère un séparateur visuel lors d'une navigation.
 * @param {string} url
 */
function insertNavigationSeparator(url) {
  const sep = document.createElement('div');
  sep.className = 'event-item--nav-separator';

  const icon = document.createElement('span');
  icon.textContent = '→';
  icon.style.color = 'var(--color-pageview)';
  icon.style.fontSize = '10px';

  const label = document.createElement('span');
  label.className = 'nav-url';
  label.textContent = url;
  label.title = url;

  sep.appendChild(icon);
  sep.appendChild(label);
  eventsList.appendChild(sep);
}

/**
 * Construit un élément DOM pour un événement de la timeline.
 * @param {Object} event
 * @returns {HTMLElement}
 */
function buildEventItem(event) {
  const label   = getEventLabel(event);
  const type    = getEventType(label);
  const time    = formatTime(event.timestamp);
  const seq     = '#' + allEvents.length;

  const item = document.createElement('div');
  item.className = 'event-item';
  item.setAttribute('role', 'listitem');
  item.dataset.eventId = event.id;
  if (event.isInitial) item.classList.add('event-item--initial');
  if (event.payload?.__gtmPreviewSynthetic) item.classList.add('event-item--synthetic');

  // Point coloré
  const dot = document.createElement('span');
  dot.className = `event-dot event-dot--${type}`;

  // Nom
  const name = document.createElement('span');
  name.className = 'event-name';
  name.textContent = label;
  name.title = label;

  item.appendChild(dot);
  item.appendChild(name);

  // Badge "synthétique" (généré par notre hook, pas par GTM)
  if (event.payload?.__gtmPreviewSynthetic) {
    const synthBadge = document.createElement('span');
    synthBadge.className = 'synthetic-badge';
    synthBadge.title = 'Événement synthétique généré par GTM Preview (GTM non détecté)';
    synthBadge.textContent = 'hook';
    item.appendChild(synthBadge);
  }

  // Badge triggers matchés (Phase 2)
  if (event.triggerResults) {
    const matchedCount = event.triggerResults.filter(r => r.matched).length;
    const badge = document.createElement('span');
    badge.className = 'trigger-badge' + (matchedCount === 0 ? ' trigger-badge--zero' : '');
    badge.textContent = matchedCount;
    badge.title = `${matchedCount} trigger(s) déclenché(s)`;
    item.appendChild(badge);
  }

  // Badge tags déclenchés (Phase 4)
  if (event.tagResults) {
    const firedCount = event.tagResults.filter(r => r.status === 'FIRED').length;
    const tagBadge = document.createElement('span');
    tagBadge.className = 'tag-badge' + (firedCount === 0 ? ' tag-badge--zero' : '');
    tagBadge.textContent = firedCount + ' tag' + (firedCount !== 1 ? 's' : '');
    tagBadge.title = `${firedCount} tag(s) déclenché(s)`;
    item.appendChild(tagBadge);
  }

  // Heure
  const timeEl = document.createElement('span');
  timeEl.className = 'event-time';
  timeEl.textContent = time;

  // Numéro de séquence
  const seqEl = document.createElement('span');
  seqEl.className = 'event-seq';
  seqEl.textContent = seq;

  item.appendChild(timeEl);
  item.appendChild(seqEl);

  // Clic → sélection et affichage du détail
  item.addEventListener('click', () => selectEvent(event, item));

  return item;
}

// ─── Sélection et détail ──────────────────────────────────────────────────────

/**
 * Sélectionne un événement et affiche son détail dans le panneau droit.
 * @param {Object}      event - L'événement sélectionné
 * @param {HTMLElement} item  - L'élément DOM correspondant
 */
function selectEvent(event, item) {
  // Désélectionner le précédent
  const prev = eventsList.querySelector('.event-item.selected');
  if (prev) prev.classList.remove('selected');

  // Sélectionner le nouveau
  item.classList.add('selected');
  selectedEventId = event.id;

  // Mémoriser l'événement courant pour l'onglet Variables
  currentVarEvent = event;

  // Afficher le détail
  showEventDetail(event);
}

/**
 * Affiche le détail d'un événement dans le panneau droit.
 * @param {Object} event
 */
function showEventDetail(event) {
  const label = getEventLabel(event);
  const type  = getEventType(label);

  // Masquer le placeholder
  detailPlaceholder.hidden = true;
  detailContent.hidden = false;

  // Badge de type
  detailEventBadge.className = `detail-event-badge type--${type}`;
  detailEventBadge.textContent = type;

  // Nom de l'événement
  detailEventName.textContent = label;

  // Horodatage complet
  detailTimestamp.textContent = formatTimeFull(event.timestamp);

  // Index dans le dataLayer
  detailIndex.textContent = `index: ${event.index}`;

  // JSON du push reçu
  jsonPush.innerHTML = syntaxHighlight(event.payload);

  // dataLayer fusionné à ce point dans le temps
  const merged = buildMergedDataLayerAt(event.id);
  jsonDataLayer.innerHTML = syntaxHighlight(merged);

  // Résultats des triggers (Phase 2)
  renderTriggerResults(event.triggerResults);

  // Résultats des tags (Phase 4)
  renderTagsTab(event.tagResults);

  // Variables résolues (Phase 3) — rendu déclenché si l'onglet est actif
  // (sinon sera rendu au clic sur l'onglet)
  const varTabActive = document.getElementById('tab-variables')?.classList.contains('active');
  if (varTabActive) renderVariablesTab(event);
}

// ─── Rendu des résultats de triggers ─────────────────────────────────────────

/**
 * Génère l'interface des triggers évalués pour un événement.
 * Groupe les triggers en 3 catégories :
 *   • Matchés (verts) — trigger déclenché
 *   • Filtre non satisfait (oranges) — bon type, mais condition échouée
 *   • Type incompatible (gris) — l'événement n'active pas ce type de trigger
 *
 * @param {Array|null} results - Tableau de TriggerResult, ou null si pas de conteneur
 */
function renderTriggerResults(results) {
  // Mise à jour du label de l'onglet
  if (!results) {
    tabTriggerBtn.textContent = 'Triggers';
    triggerResults.innerHTML = `
      <div class="triggers-empty">
        <p class="triggers-empty__title">Aucun conteneur GTM chargé</p>
        <p class="triggers-empty__sub">
          Importez un fichier JSON GTM depuis le popup de l'extension
          pour voir les triggers évalués ici.
        </p>
      </div>`;
    return;
  }

  if (results.length === 0) {
    tabTriggerBtn.textContent = 'Triggers (0)';
    triggerResults.innerHTML = '<div class="triggers-empty"><p class="triggers-empty__title">Aucun trigger dans ce conteneur</p></div>';
    return;
  }

  // Grouper les résultats
  const matched    = results.filter(r => r.matched);
  const failed     = results.filter(r => !r.matched && r.reason !== 'type_mismatch' && r.reason !== 'unsupported_type');
  const mismatch   = results.filter(r => r.reason === 'type_mismatch');
  const unsupported = results.filter(r => r.reason === 'unsupported_type');

  // Mettre à jour le label de l'onglet
  tabTriggerBtn.textContent = `Triggers (${matched.length})`;

  // Construire le HTML
  let html = `<div class="triggers-summary">
    <strong>${matched.length}</strong> déclenché(s) /
    <strong>${results.length}</strong> évalué(s)
  </div>`;

  if (matched.length > 0) {
    html += buildTriggerGroup('Déclenchés', 'matched', matched);
  }
  if (failed.length > 0) {
    html += buildTriggerGroup('Filtre non satisfait', 'failed', failed);
  }
  if (mismatch.length > 0) {
    html += buildTriggerGroup('Type incompatible', 'mismatch', mismatch);
  }
  if (unsupported.length > 0) {
    html += buildTriggerGroup('Non supportés', 'unsupported', unsupported);
  }

  triggerResults.innerHTML = html;
}

/**
 * Construit le HTML d'un groupe de triggers.
 * @param {string} title     - Titre du groupe
 * @param {string} className - Classe CSS du groupe (matched|failed|mismatch|unsupported)
 * @param {Array}  items     - TriggerResults du groupe
 * @returns {string} HTML
 */
function buildTriggerGroup(title, className, items) {
  const itemsHtml = items.map(r => buildTriggerItem(r, className)).join('');
  return `
    <div class="trigger-group">
      <div class="trigger-group__title trigger-group__title--${className}">
        ${title} (${items.length})
      </div>
      ${itemsHtml}
    </div>`;
}

/**
 * Construit le HTML d'un trigger item.
 * @param {Object} r         - TriggerResult
 * @param {string} className - Classe CSS du groupe
 * @returns {string} HTML
 */
function buildTriggerItem(r, className) {
  const icon     = className === 'matched' ? '✓' : className === 'mismatch' ? '–' : '✗';
  const typeClass = getTriggerTypeClass(r.triggerType);

  // Tags qui se déclencheraient (pour les triggers matchés)
  let tagsHtml = '';
  if (r.matched && r.firingTags && r.firingTags.length > 0) {
    const tagList = r.firingTags
      .map(t => `<span class="trigger-firing-tag" title="Tag ID: ${escapeHtml(t.tagId)}">${escapeHtml(t.tagName)}</span>`)
      .join('');
    tagsHtml = `<div class="trigger-firing-tags">→ ${tagList}</div>`;
  }

  // Détail de la condition échouée
  let failedHtml = '';
  if (r.failedCondition) {
    const fc = r.failedCondition;
    const arg0 = escapeHtml(fc.arg0Raw !== fc.arg0Resolved
      ? `${fc.arg0Raw} → "${fc.arg0Resolved}"`
      : `"${fc.arg0Resolved}"`);
    const arg1 = escapeHtml(`"${fc.arg1Resolved}"`);
    failedHtml = `<div class="trigger-condition-detail">${arg0} <em>${escapeHtml(fc.operator)}</em> ${arg1}</div>`;
  } else if (r.reasonLabel && !r.matched) {
    failedHtml = `<div class="trigger-condition-detail">${escapeHtml(r.reasonLabel)}</div>`;
  }

  return `
    <div class="trigger-item trigger-item--${className}">
      <span class="trigger-item__icon">${icon}</span>
      <div class="trigger-item__body">
        <div class="trigger-item__header">
          <span class="trigger-item__name">${escapeHtml(r.triggerName)}</span>
          <span class="trigger-type-pill trigger-type-pill--${typeClass}">${escapeHtml(r.triggerType)}</span>
        </div>
        ${failedHtml}
        ${tagsHtml}
      </div>
    </div>`;
}

/**
 * Retourne la classe CSS pour un type de trigger.
 * @param {string} type
 * @returns {string}
 */
function getTriggerTypeClass(type) {
  switch (type) {
    case 'PAGEVIEW':            return 'pageview';
    case 'DOM_READY':           return 'dom';
    case 'WINDOW_LOADED':       return 'window';
    case 'CUSTOM_EVENT':        return 'custom';
    case 'CLICK':               return 'click';
    case 'LINK_CLICK':          return 'click';
    case 'FORM_SUBMIT':         return 'form';
    case 'HISTORY_CHANGE':      return 'history';
    case 'SCROLL_DEPTH':        return 'scroll';
    case 'ELEMENT_VISIBILITY':  return 'visibility';
    case 'INIT':                return 'init';
    case 'JS_ERROR':            return 'error';
    case 'TIMER':               return 'timer';
    case 'YOUTUBE_VIDEO':       return 'video';
    default:                    return 'other';
  }
}

/**
 * Échappe les caractères HTML pour affichage sûr.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Reconstitue l'état fusionné du dataLayer jusqu'à l'événement donné.
 * GTM merge les objets successifs dans un état global.
 * @param {number} untilId - id de l'événement (inclus)
 * @returns {Object}
 */
function buildMergedDataLayerAt(untilId) {
  const merged = {};
  for (const event of allEvents) {
    // Ne fusionner que les événements non-initiaux et jusqu'à l'id voulu
    if (event.payload && typeof event.payload === 'object') {
      Object.assign(merged, event.payload);
    }
    if (event.id === untilId) break;
  }
  return merged;
}

// ─── Onglets du détail ────────────────────────────────────────────────────────

detailTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    // Désactiver tous les onglets et contenus
    detailTabs.forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.detail-tab-content').forEach(c => c.classList.remove('active'));

    // Activer l'onglet cliqué
    tab.classList.add('active');
    const targetId = 'tab-' + tab.dataset.tab;
    document.getElementById(targetId).classList.add('active');

    // Déclencher le rendu de l'onglet Variables si nécessaire
    if (tab.dataset.tab === 'variables' && currentVarEvent) {
      renderVariablesTab(currentVarEvent);
    }
    // Mettre à jour le filtre de tags si on ouvre l'onglet Tags
    if (tab.dataset.tab === 'tags') {
      applyTagFilter();
    }
  });
});

// ─── Filtre / recherche ───────────────────────────────────────────────────────

searchInput.addEventListener('input', () => {
  filterText = searchInput.value.trim().toLowerCase();
  applyFilterAll();
});

/**
 * Applique le filtre texte à tous les éléments de la liste.
 */
function applyFilterAll() {
  const items = eventsList.querySelectorAll('.event-item');
  items.forEach((item) => {
    const eventId = parseInt(item.dataset.eventId, 10);
    const event   = allEvents.find(e => e.id === eventId);
    if (!event) return;
    applyFilterToItem(item, getEventLabel(event));
  });
  updateEventsCount();
}

/**
 * Affiche ou masque un élément selon le filtre courant.
 * @param {HTMLElement} item
 * @param {string}      label
 */
function applyFilterToItem(item, label) {
  if (!filterText) {
    item.hidden = false;
    return;
  }
  const matches = label.toLowerCase().includes(filterText);
  item.hidden = !matches;
}

// ─── Effacement ───────────────────────────────────────────────────────────────

btnClear.addEventListener('click', () => {
  clearAll();
});

function clearAll() {
  allEvents.length = 0;
  selectedEventId = null;
  eventsList.innerHTML = '';
  emptyState.hidden = false;
  detailPlaceholder.hidden = false;
  detailContent.hidden = true;
  updateEventsCount();
  setStatusBar('Historique effacé');

  // Notifier le service worker
  if (swPort) {
    swPort.postMessage({ type: 'CLEAR_EVENTS' });
  }
}

// ─── Export JSON ─────────────────────────────────────────────────────────────

/**
 * Exporte tous les événements en téléchargeant un fichier JSON.
 */
function exportEvents() {
  if (allEvents.length === 0) {
    setStatusBar('Aucun événement à exporter.');
    return;
  }
  const payload = {
    exportedAt:  new Date().toISOString(),
    eventCount:  allEvents.length,
    events:      allEvents,
  };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `gtm-preview-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  setStatusBar(`${allEvents.length} événement(s) exporté(s).`);
}

if (btnExport) {
  btnExport.addEventListener('click', exportEvents);
}

// ─── Copier dans le presse-papier ─────────────────────────────────────────────

/**
 * Copie un texte dans le presse-papier et confirme dans la barre de statut.
 * @param {string} text
 */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    setStatusBar('Copié dans le presse-papier.');
  } catch {
    setStatusBar('Impossible de copier (permission refusée).');
  }
}

if (btnCopyPush) {
  btnCopyPush.addEventListener('click', () => {
    const raw = jsonPush.textContent;
    copyToClipboard(raw);
  });
}

if (btnCopyDL) {
  btnCopyDL.addEventListener('click', () => {
    const raw = jsonDataLayer.textContent;
    copyToClipboard(raw);
  });
}

// ─── Navigation clavier ───────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  // Ignorer si le focus est dans un champ texte
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if (e.key === 'Escape') {
    // Désélectionner l'événement courant
    const prev = eventsList.querySelector('.event-item.selected');
    if (prev) prev.classList.remove('selected');
    selectedEventId = null;
    detailPlaceholder.hidden = false;
    detailContent.hidden = true;
    e.preventDefault();
    return;
  }

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const visibleItems = [...eventsList.querySelectorAll('.event-item:not([hidden])')];
    if (visibleItems.length === 0) return;

    const currentItem = eventsList.querySelector('.event-item.selected');
    const currentIdx  = currentItem ? visibleItems.indexOf(currentItem) : -1;
    const delta       = e.key === 'ArrowDown' ? 1 : -1;
    const nextIdx     = Math.max(0, Math.min(visibleItems.length - 1, currentIdx + delta));
    const nextItem    = visibleItems[nextIdx];

    if (nextItem && nextItem !== currentItem) {
      const eventId = parseInt(nextItem.dataset.eventId, 10);
      const event   = allEvents.find(ev => ev.id === eventId);
      if (event) {
        selectEvent(event, nextItem);
        nextItem.scrollIntoView({ block: 'nearest' });
      }
    }
    e.preventDefault();
  }
});

// ─── Compteur d'événements ────────────────────────────────────────────────────

function updateEventsCount() {
  const visible = eventsList.querySelectorAll('.event-item:not([hidden])').length;
  const total   = allEvents.length;
  eventsCount.textContent = filterText ? `${visible}/${total}` : String(total);
}

// ─── Chargement infos conteneur ───────────────────────────────────────────────

/**
 * Récupère les infos du conteneur GTM depuis le storage et les affiche.
 */
function loadContainerInfo() {
  chrome.storage.local.get(['gtmContainer'], (result) => {
    if (result.gtmContainer) {
      const cv = result.gtmContainer.containerVersion;
      const name   = cv?.container?.name || 'Inconnu';
      const pubId  = cv?.container?.publicId || '';
      containerInfo.textContent = `${name}${pubId ? ' (' + pubId + ')' : ''}`;
      containerInfo.title = `Conteneur : ${name} — ${pubId}`;
    } else {
      containerInfo.textContent = 'Aucun conteneur';
    }
  });
}

// ─── Redimensionnement du panneau gauche ──────────────────────────────────────

(function setupResizer() {
  let dragging = false;
  let startX   = 0;
  let startW   = 0;

  // Restaurer la largeur sauvegardée
  const savedW = localStorage.getItem('gtmPreview_panelWidth');
  if (savedW) eventsPanel.style.width = savedW + 'px';

  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    startX   = e.clientX;
    startW   = eventsPanel.offsetWidth;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    const newW  = Math.min(Math.max(startW + delta, 160), window.innerWidth * 0.6);
    eventsPanel.style.width = newW + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Persister la largeur
    localStorage.setItem('gtmPreview_panelWidth', eventsPanel.offsetWidth);
  });
})();

// ─── Écoute du storage (import d'un nouveau conteneur via le popup) ───────────

chrome.storage.onChanged.addListener((changes) => {
  if (changes.gtmContainer) {
    loadContainerInfo();
  }
});

// ─── Utilitaires ──────────────────────────────────────────────────────────────

/**
 * Extrait le nom/label d'un événement dataLayer.
 * @param {Object} event
 * @returns {string}
 */
function getEventLabel(event) {
  if (!event.payload) return '(vide)';
  if (typeof event.payload.event === 'string') return event.payload.event;
  // Pas de clé "event" → on prend la première clé
  const keys = Object.keys(event.payload);
  if (keys.length > 0) return keys[0] + ':…';
  return '(objet vide)';
}

/**
 * Détermine le type visuel d'un événement selon son nom.
 * @param {string} label
 * @returns {'gtm'|'pageview'|'custom'|'consent'|'initial'}
 */
function getEventType(label) {
  if (!label) return 'initial';
  const l = label.toLowerCase();
  if (l.startsWith('gtm.')) return 'gtm';
  if (l === 'pageview' || l === 'page_view') return 'pageview';
  if (l.includes('consent')) return 'consent';
  return 'custom';
}

/**
 * Formate un timestamp en HH:MM:SS.mmm
 * @param {number} ts
 * @returns {string}
 */
function formatTime(ts) {
  const d = new Date(ts);
  const h  = String(d.getHours()).padStart(2, '0');
  const m  = String(d.getMinutes()).padStart(2, '0');
  const s  = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

/**
 * Formate un timestamp complet pour l'en-tête du détail.
 * @param {number} ts
 * @returns {string}
 */
function formatTimeFull(ts) {
  return new Date(ts).toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  });
}

/**
 * Génère du HTML avec coloration syntaxique pour un objet JSON.
 * @param {*} obj
 * @returns {string} HTML
 */
function syntaxHighlight(obj) {
  let json;
  try {
    json = JSON.stringify(obj, null, 2);
  } catch (e) {
    return '<span class="json-string">"[Non-sérialisable]"</span>';
  }

  // Échapper les caractères HTML avant toute manipulation
  json = json
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Coloration syntaxique : on enveloppe chaque token dans un <span>
  // Le regex capture : chaînes (avec ou sans ":" final pour les clés),
  // booléens, null, et nombres
  return json.replace(
    /("(?:\\u[\dA-Fa-f]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      let cls;
      if (match.startsWith('"')) {
        // Clé JSON : la chaîne est suivie d'un ":"
        cls = match.trimEnd().endsWith(':') ? 'json-key' : 'json-string';
      } else if (match === 'true' || match === 'false') {
        cls = 'json-bool';
      } else if (match === 'null') {
        cls = 'json-null';
      } else {
        cls = 'json-number';
      }
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

// ─── Onglet Tags (Phase 4) ────────────────────────────────────────────────────

/** Résultats des tags pour l'événement courant */
let currentTagResults = null;

/** Filtre de statut courant ('all'|'FIRED'|'BLOCKED'|'NOT_FIRED') */
let tagStatusFilter = 'all';

/** Filtre texte courant pour les tags */
let tagNameFilter = '';

/**
 * Affiche l'onglet Tags pour l'événement sélectionné.
 * @param {Array|null} results - Tableau de TagResult, ou null si pas de conteneur
 */
function renderTagsTab(results) {
  currentTagResults = results;

  if (!results) {
    if (tabTagsBtn) tabTagsBtn.textContent = 'Tags';
    tagsList.innerHTML = `
      <div class="tags-empty">
        <p class="tags-empty__title">Aucun conteneur GTM chargé</p>
        <p class="tags-empty__sub">
          Importez un fichier JSON GTM depuis le popup de l'extension
          pour voir les tags évalués ici.
        </p>
      </div>`;
    return;
  }

  if (results.length === 0) {
    if (tabTagsBtn) tabTagsBtn.textContent = 'Tags (0)';
    tagsList.innerHTML = '<div class="tags-empty"><p class="tags-empty__title">Aucun tag dans ce conteneur</p></div>';
    return;
  }

  const firedCount   = results.filter(r => r.status === 'FIRED').length;
  const blockedCount = results.filter(r => r.status === 'BLOCKED').length;

  if (tabTagsBtn) tabTagsBtn.textContent = `Tags (${firedCount}/${results.length})`;

  applyTagFilter();
}

/**
 * Applique le filtre de statut courant à la liste de tags.
 */
function applyTagFilter() {
  if (!currentTagResults) return;

  // Mettre à jour les boutons de filtre
  document.querySelectorAll('.tag-filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === tagStatusFilter);
  });

  const nameFilter = tagNameFilter.toLowerCase();
  const filtered = currentTagResults.filter(r => {
    if (tagStatusFilter !== 'all' && r.status !== tagStatusFilter) return false;
    if (nameFilter && !r.tagName.toLowerCase().includes(nameFilter)) return false;
    return true;
  });

  if (filtered.length === 0) {
    tagsList.innerHTML = '<div class="tags-empty"><p class="tags-empty__title">Aucun tag dans cette catégorie.</p></div>';
    return;
  }

  tagsList.innerHTML = filtered.map(r => buildTagItem(r)).join('');
}

/**
 * Construit le HTML d'une ligne de tag.
 * @param {Object} r - TagResult
 * @returns {string} HTML
 */
function buildTagItem(r) {
  const statusClass = r.status === 'FIRED' ? 'fired'
                    : r.status === 'BLOCKED' ? 'blocked'
                    : 'not-fired';
  const icon = r.status === 'FIRED' ? '▶' : r.status === 'BLOCKED' ? '⊘' : '—';
  const typeClass = getTagTypeClass(r.tagType);

  // Détail du déclenchement / blocage
  let detailHtml = `<div class="tag-item__reason">${escapeHtml(r.reason)}</div>`;

  // Infos de sequencing
  if (r.sequencingBlocked) {
    detailHtml += `<div class="tag-item__seq">⛓ Setup tag défaillant</div>`;
  }

  // fireCount pour ONCE
  let onceHtml = '';
  if (r.firingOption === 'ONCE') {
    onceHtml = `<span class="tag-item__once" title="Option ONCE — déclenché ${r.fireCount}x sur cette page">ONCE×${r.fireCount}</span>`;
  }

  return `
    <div class="tag-item tag-item--${statusClass}" data-tag-id="${escapeHtml(r.tagId)}">
      <span class="tag-item__icon">${icon}</span>
      <div class="tag-item__body">
        <div class="tag-item__header">
          <span class="tag-item__name" title="${escapeHtml(r.tagName)}">${escapeHtml(r.tagName)}</span>
          <span class="tag-type-pill tag-type-pill--${typeClass}">${escapeHtml(r.tagTypeLabel)}</span>
          ${onceHtml}
          <span class="tag-item__priority" title="Priorité">${r.priority > 0 ? 'P:' + r.priority : ''}</span>
        </div>
        ${detailHtml}
      </div>
    </div>`;
}

/**
 * Retourne la classe CSS pour un type de tag GTM.
 * @param {string} type
 * @returns {string}
 */
function getTagTypeClass(type) {
  switch (type) {
    case 'html':  return 'html';
    case 'gaawc': return 'ga4';
    case 'gaawe': return 'ga4';
    case 'ua':    return 'ua';
    case 'awct':  return 'ads';
    case 'sp':    return 'ads';
    case 'flc':
    case 'fls':   return 'floodlight';
    default:      return 'other';
  }
}

// ─── Tag detail (click pour expandre les paramètres) ─────────────────────────

/**
 * Délégation de clic sur la liste des tags.
 * Toggle le détail des paramètres d'un tag au clic.
 */
tagsList.addEventListener('click', (e) => {
  const item = e.target.closest('.tag-item');
  if (!item) return;
  toggleTagDetail(item);
});

/**
 * Ouvre ou ferme le détail des paramètres d'un tag.
 * @param {HTMLElement} item - L'élément .tag-item cliqué
 */
function toggleTagDetail(item) {
  // Fermer si déjà ouvert
  const existing = item.nextElementSibling;
  if (existing?.classList.contains('tag-detail')) {
    item.classList.remove('expanded');
    existing.remove();
    return;
  }

  // Fermer les autres détails ouverts
  const openDetails = tagsList.querySelectorAll('.tag-detail');
  openDetails.forEach(d => {
    d.previousElementSibling?.classList.remove('expanded');
    d.remove();
  });

  item.classList.add('expanded');

  const tagId = item.dataset.tagId;
  const result = currentTagResults?.find(r => r.tagId === tagId);
  if (!result) return;

  const detailEl = buildTagDetailEl(result, currentVarEvent?.variableValues);
  item.insertAdjacentElement('afterend', detailEl);
}

/**
 * Construit l'élément DOM du détail des paramètres d'un tag.
 * @param {Object} result        - TagResult (avec tagParams)
 * @param {Object} variableValues - Variables résolues pour l'événement courant
 * @returns {HTMLElement}
 */
function buildTagDetailEl(result, variableValues) {
  const div = document.createElement('div');
  div.className = 'tag-detail';

  const params = result.tagParams;
  if (!params || params.length === 0) {
    div.innerHTML = '<p class="tag-detail__empty">Aucun paramètre</p>';
    return div;
  }

  const rows = params.map(p => {
    const key = escapeHtml(p.key || '');
    let valueHtml;

    if (p.list) {
      valueHtml = `<span class="tag-param-complex">[liste — ${p.list.length} élément(s)]</span>`;
    } else if (p.map) {
      valueHtml = `<span class="tag-param-complex">[map — ${p.map.length} entrée(s)]</span>`;
    } else {
      const raw = p.value ?? '';
      valueHtml = `<span class="tag-param-raw">${escapeHtml(String(raw))}</span>`;

      // Résolution des références {{VarName}}
      if (typeof raw === 'string' && raw.includes('{{') && variableValues) {
        const resolved = resolveParamDisplay(raw, variableValues);
        if (resolved !== null && resolved !== raw) {
          valueHtml += ` <span class="tag-param-resolved">→ ${escapeHtml(String(resolved))}</span>`;
        }
      }
    }

    return `<tr><td class="tag-param-key">${key}</td><td class="tag-param-value">${valueHtml}</td></tr>`;
  }).join('');

  div.innerHTML = `<table class="tag-params-table"><tbody>${rows}</tbody></table>`;
  return div;
}

/**
 * Résout les références {{VarName}} dans une valeur de paramètre.
 * @param {string} template
 * @param {Object} variableValues
 * @returns {string|null} Valeur résolue, ou null si aucune variable connue
 */
function resolveParamDisplay(template, variableValues) {
  // Template = une seule variable
  const single = template.match(/^\{\{([^}]+)\}\}$/);
  if (single) {
    const name = single[1].trim();
    if (name in variableValues) return variableValues[name];
    return null;
  }
  // Interpolation dans une chaîne
  let hasResolved = false;
  const result = template.replace(/\{\{([^}]+)\}\}/g, (_, name) => {
    const v = variableValues[name.trim()];
    if (v !== undefined && v !== null) { hasResolved = true; return String(v); }
    return `{{${name}}}`;
  });
  return hasResolved ? result : null;
}

// Boutons de filtre des tags
document.querySelectorAll('.tag-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    tagStatusFilter = btn.dataset.filter;
    applyTagFilter();
  });
});

// Recherche par nom de tag
if (tagSearch) {
  tagSearch.addEventListener('input', () => {
    tagNameFilter = tagSearch.value.trim();
    applyTagFilter();
  });
}

// ─── Onglet Variables (Phase 3) ───────────────────────────────────────────────

/** Cache du conteneur chargé (pour éviter de refaire un storage.get à chaque sélection) */
let cachedContainerForVars = null;

/** Événement actuellement affiché dans l'onglet Variables */
let currentVarEvent = null;

/** Filtre de recherche de variables */
let varFilterText = '';

// Mettre à jour le cache si le conteneur change
chrome.storage.onChanged.addListener((changes) => {
  if (changes.gtmContainer) {
    cachedContainerForVars = null;
    loadContainerInfo();
  }
});

/**
 * Charge le conteneur depuis le storage (avec cache local).
 * @returns {Promise<Object|null>}
 */
function getContainerForVars() {
  if (cachedContainerForVars) return Promise.resolve(cachedContainerForVars);
  return new Promise(resolve => {
    chrome.storage.local.get(['gtmContainer'], result => {
      cachedContainerForVars = result.gtmContainer || null;
      resolve(cachedContainerForVars);
    });
  });
}

/**
 * Affiche l'onglet Variables pour l'événement sélectionné.
 * @param {Object} event - L'événement enrichi (avec event.variableValues)
 */
async function renderVariablesTab(event) {
  currentVarEvent = event;

  const container = await getContainerForVars();
  if (!container) {
    variablesList.innerHTML = `
      <div class="variables-empty">
        <p class="variables-empty__title">Aucun conteneur GTM chargé</p>
        <p class="variables-empty__sub">Importez un JSON GTM depuis le popup pour voir les variables.</p>
      </div>`;
    tabVariablesBtn.textContent = 'Variables';
    return;
  }

  const cv = container.containerVersion;

  // Construire la liste des variables à afficher
  // 1. Built-ins déclarés
  const builtIns = (cv.builtInVariable || []).map(bv => ({
    name:    bv.name,
    gtmType: bv.type,
    display: 'built-in',
  }));

  // 2. Variables utilisateur
  const userVars = (cv.variable || []).map(v => ({
    name:      v.name,
    gtmType:   v.type,
    display:   varTypeLabel(v.type),
    params:    v.parameter,
  }));

  const allVars = [...builtIns, ...userVars];
  const values  = event.variableValues || {};

  tabVariablesBtn.textContent = `Variables (${allVars.length})`;

  renderVariableRows(allVars, values);
}

/**
 * Rend les lignes de variables en appliquant le filtre courant.
 * @param {Array}  allVars - Liste des définitions de variables
 * @param {Object} values  - Map name → resolved value
 */
function renderVariableRows(allVars, values) {
  const filter = varFilterText.toLowerCase();

  const filtered = filter
    ? allVars.filter(v => v.name.toLowerCase().includes(filter))
    : allVars;

  if (filtered.length === 0) {
    variablesList.innerHTML = `<div class="variables-empty"><p class="variables-empty__title">Aucune variable ne correspond au filtre.</p></div>`;
    return;
  }

  // Grouper : built-ins d'abord, puis utilisateur
  const biRows   = filtered.filter(v => v.display === 'built-in');
  const userRows = filtered.filter(v => v.display !== 'built-in');

  let html = '';

  if (biRows.length > 0) {
    html += `<div class="var-group-title">Variables built-in (${biRows.length})</div>`;
    biRows.forEach(v => { html += buildVarRow(v, values[v.name]); });
  }

  if (userRows.length > 0) {
    html += `<div class="var-group-title">Variables utilisateur (${userRows.length})</div>`;
    userRows.forEach(v => { html += buildVarRow(v, values[v.name]); });
  }

  variablesList.innerHTML = html;

  // Démarrer les évaluations page-side asynchrones
  evaluatePageVars(allVars, values, filter);
}

/**
 * Remplace les références GTM {{VarName}} dans un code généré par leur
 * valeur résolue sérialisée, avant de l'envoyer à inspectedWindow.eval.
 * Nécessaire car les Custom JS variables GTM peuvent contenir {{OtherVar}}.
 * @param {string} code
 * @param {Object} values - Map { variableName: resolvedValue }
 * @returns {string}
 */
function resolveGtmRefsInCode(code, values) {
  if (!code || !code.includes('{{')) return code;
  return code.replace(/\{\{([^}]+)\}\}/g, (match, varName) => {
    const name = varName.trim();
    if (values && Object.prototype.hasOwnProperty.call(values, name)) {
      try { return JSON.stringify(values[name]); } catch { return 'undefined'; }
    }
    return 'undefined';
  });
}

/**
 * Pour chaque variable nécessitant une éval page, lance l'éval et met à jour la cellule.
 */
function evaluatePageVars(allVars, values, filter) {
  const PAGE_EVAL_KEY = '__gtmPreviewPageEval';

  allVars.forEach(varDef => {
    if (filter && !varDef.name.toLowerCase().includes(filter)) return;

    const value = values[varDef.name];
    if (!value || typeof value !== 'object' || !value[PAGE_EVAL_KEY]) return;

    const rowId   = 'var-row-' + varNameToId(varDef.name);
    const cell    = document.getElementById(rowId);
    if (!cell) return;

    // Résoudre les {{VarName}} GTM dans le code avant eval
    const codeToEval = resolveGtmRefsInCode(value.code, values);

    // Lancer l'évaluation dans la page
    chrome.devtools.inspectedWindow.eval(
      codeToEval,
      (result, exceptionInfo) => {
        if (!cell) return;
        if (exceptionInfo) {
          const msg = exceptionInfo.description || exceptionInfo.value || 'Erreur';
          cell.innerHTML = `<span class="var-value var-value--error" title="${escapeHtml(msg)}">[Erreur: ${escapeHtml(String(msg).slice(0, 80))}]</span>`;
        } else {
          cell.innerHTML = formatVarValue(result);
        }
      }
    );
  });
}

/**
 * Construit une ligne HTML pour une variable.
 */
function buildVarRow(varDef, value) {
  const rowId      = 'var-row-' + varNameToId(varDef.name);
  const typeClass  = varTypeClass(varDef.gtmType || varDef.display);
  const typeLabel  = varDef.display === 'built-in' ? 'built-in' : varTypeLabel(varDef.gtmType);

  const PAGE_EVAL_KEY = '__gtmPreviewPageEval';
  let valueHtml;

  if (value && typeof value === 'object' && value[PAGE_EVAL_KEY]) {
    // Valeur à évaluer côté page → spinner en attendant
    valueHtml = `<span class="var-value var-value--loading">⟳ évaluation…</span>`;
  } else {
    valueHtml = formatVarValue(value);
  }

  return `
    <div class="var-row">
      <span class="var-name" title="${escapeHtml(varDef.name)}">${escapeHtml(varDef.name)}</span>
      <span class="var-type var-type--${typeClass}">${escapeHtml(typeLabel)}</span>
      <span class="var-value-cell" id="${escapeHtml(rowId)}">${valueHtml}</span>
    </div>`;
}

/**
 * Formate une valeur résolue pour l'affichage.
 * @param {*} value
 * @returns {string} HTML
 */
function formatVarValue(value) {
  if (value === undefined || value === null && value !== 0) {
    const display = value === undefined ? '—' : 'null';
    return `<span class="var-value var-value--undefined">${display}</span>`;
  }
  if (typeof value === 'boolean') {
    return `<span class="var-value var-value--bool">${value}</span>`;
  }
  if (typeof value === 'number') {
    return `<span class="var-value var-value--number">${value}</span>`;
  }
  if (typeof value === 'string') {
    // Tronquer les longues chaînes
    const display = value.length > 120 ? value.slice(0, 120) + '…' : value;
    return `<span class="var-value var-value--string" title="${escapeHtml(value)}">"${escapeHtml(display)}"</span>`;
  }
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      const display = json.length > 120 ? json.slice(0, 120) + '…}' : json;
      return `<span class="var-value var-value--object" title="${escapeHtml(json)}">${escapeHtml(display)}</span>`;
    } catch {
      return `<span class="var-value var-value--object">[Object]</span>`;
    }
  }
  return `<span class="var-value">${escapeHtml(String(value))}</span>`;
}

/** Transforme un nom de variable en ID DOM safe */
function varNameToId(name) {
  return name.replace(/[^a-zA-Z0-9]/g, '_');
}

/** Label lisible pour un type de variable GTM */
function varTypeLabel(type) {
  const labels = {
    'c':    'Constante',   'v':    'DataLayer',  'u':    'URL',
    'k':    'Cookie',      'j':    'JS Var',      'jsm':  'Custom JS',
    'd':    'DOM',         'smm':  'Lookup',      'remm': 'Regex',
    'aev':  'Auto-Event',  'f':    'Referrer',    'gas':  'GA Settings',
  };
  return labels[type] || type || '?';
}

/** Classe CSS pour le badge de type */
function varTypeClass(type) {
  const classes = {
    'c': 'constant', 'v': 'dlv',    'u': 'url',
    'k': 'cookie',   'j': 'jsvar',  'jsm': 'customjs',
    'd': 'dom',      'smm': 'lookup', 'remm': 'regex',
    'aev': 'aev',    'f': 'referrer', 'built-in': 'builtin',
  };
  return classes[type] || 'other';
}

// ─── Contrôles de l'onglet Variables ──────────────────────────────────────────

varSearch.addEventListener('input', () => {
  varFilterText = varSearch.value.trim();
  if (currentVarEvent) renderVariablesTab(currentVarEvent);
});

btnReeval.addEventListener('click', () => {
  if (currentVarEvent) renderVariablesTab(currentVarEvent);
});

// ─── Démarrage ────────────────────────────────────────────────────────────────

loadContainerInfo();
connectToServiceWorker();
loadBlockedState();
