// ============================================================
// popup.js — Logique du popup GTM Preview
// ============================================================

'use strict';

// ─── Références DOM ───────────────────────────────────────────────────────────

const fileInput          = document.getElementById('file-input');
const btnImport          = document.getElementById('btn-import');
const btnClearContainer  = document.getElementById('btn-clear-container');
const btnOpenDevtools    = document.getElementById('btn-open-devtools');
const importFeedback     = document.getElementById('import-feedback');
const containerEmpty     = document.getElementById('container-empty');
const containerLoaded    = document.getElementById('container-loaded');
const containerName      = document.getElementById('container-name');
const containerId        = document.getElementById('container-id');
const containerVersion   = document.getElementById('container-version');
const containerTags      = document.getElementById('container-tags');
const siteHostname       = document.getElementById('site-hostname');
const siteToggle         = document.getElementById('site-toggle');
const toggleLabel        = document.getElementById('toggle-label');
const blockToggle        = document.getElementById('block-toggle');
const blockLabel         = document.getElementById('block-label');
const gtmIdSelect        = document.getElementById('gtm-id-select');
const gtmSelectorRow     = document.getElementById('gtm-selector-row');
const liveToggle         = document.getElementById('live-toggle');
const liveLabel          = document.getElementById('live-label');
const liveModeRow        = document.getElementById('live-mode-row');
const badgeMode          = document.getElementById('badge-mode');
const siteFeedback       = document.getElementById('site-feedback');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalise une entrée blockedSites (ancien format: number, nouveau: objet).
 */
function normBlockEntry(v) {
  if (!v) return null;
  if (typeof v === 'number') return { ruleId: v, gtmId: null, liveMode: false };
  if (typeof v === 'object') return { ruleId: v.ruleId, gtmId: v.gtmId || null, liveMode: !!v.liveMode };
  return null;
}

// ─── Import JSON GTM ──────────────────────────────────────────────────────────

btnImport.addEventListener('click', () => {
  fileInput.value = '';
  fileInput.click();
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const json = JSON.parse(e.target.result);
      validateAndStoreContainer(json);
    } catch (err) {
      showFeedback('error', 'Fichier JSON invalide : ' + err.message);
    }
  };
  reader.onerror = () => showFeedback('error', 'Erreur lors de la lecture du fichier.');
  reader.readAsText(file);
});

function validateAndStoreContainer(json) {
  if (!json || typeof json !== 'object') {
    showFeedback('error', 'Structure JSON non reconnue.');
    return;
  }
  if (!json.containerVersion) {
    showFeedback('error', 'Clé "containerVersion" manquante. Vérifiez que c\'est bien un export GTM.');
    return;
  }

  const cv = json.containerVersion;
  const name    = cv.container?.name || cv.name || 'Inconnu';
  const nbTags  = (cv.tag || []).length;
  const nbTrigs = (cv.trigger || []).length;
  const nbVars  = (cv.variable || []).length;

  chrome.storage.local.set({ gtmContainer: json }, () => {
    if (chrome.runtime.lastError) {
      showFeedback('error', 'Erreur de stockage : ' + chrome.runtime.lastError.message);
      return;
    }
    showFeedback('success',
      `Conteneur "${name}" chargé — ${nbTags} tags, ${nbTrigs} triggers, ${nbVars} variables`
    );
    displayContainerInfo(cv);

    // Si l'ID du conteneur correspond à un GTM détecté, le pré-sélectionner
    const pubId = cv.container?.publicId || '';
    if (pubId) autoSelectGtmId(pubId);
  });
}

// ─── Affichage des infos conteneur ───────────────────────────────────────────

function displayContainerInfo(cv) {
  const name    = cv.container?.name || cv.name || 'Inconnu';
  const pubId   = cv.container?.publicId || '—';
  const version = cv.containerVersionId || '0';
  const nbTags  = (cv.tag || []).length;

  containerEmpty.style.display    = 'none';
  containerLoaded.style.display   = 'block';
  btnClearContainer.style.display = 'block';

  containerName.textContent    = name;
  containerId.textContent      = pubId;
  containerVersion.textContent = `v${version}`;
  containerTags.textContent    = `${nbTags} tag${nbTags !== 1 ? 's' : ''}`;
}

btnClearContainer.addEventListener('click', () => {
  chrome.storage.local.remove(['gtmContainer'], () => {
    containerEmpty.style.display    = 'block';
    containerLoaded.style.display   = 'none';
    btnClearContainer.style.display = 'none';
    showFeedback('success', 'Conteneur supprimé.');
  });
});

// ─── Toggle par site ──────────────────────────────────────────────────────────

function initSiteToggle() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.url) {
      siteHostname.textContent = '(non disponible)';
      siteToggle.disabled = true;
      return;
    }

    let hostname;
    try {
      hostname = new URL(tab.url).hostname;
    } catch {
      siteHostname.textContent = '(URL invalide)';
      siteToggle.disabled = true;
      return;
    }

    if (!hostname || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      siteHostname.textContent = '(page interne Chrome)';
      siteToggle.disabled = true;
      return;
    }

    siteHostname.textContent = hostname;
    siteHostname.title = tab.url;

    // Lire l'état de désactivation
    chrome.storage.local.get(['disabledSites'], (result) => {
      const disabledSites = result.disabledSites || [];
      setSiteToggleState(!disabledSites.includes(hostname));
    });

    siteToggle.addEventListener('change', () => {
      const isEnabled = siteToggle.checked;
      setSiteToggleState(isEnabled);
      updateDisabledSites(hostname, !isEnabled);
    });

    // Initialiser le toggle blocage + live mode + sélecteur GTM
    initBlockToggle(hostname, tab.id);
  });
}

function setSiteToggleState(enabled) {
  siteToggle.checked = enabled;
  toggleLabel.textContent  = enabled ? 'Activé'   : 'Désactivé';
  toggleLabel.style.color  = enabled ? 'var(--green)' : 'var(--text-dim)';
}

function updateDisabledSites(hostname, disable) {
  chrome.storage.local.get(['disabledSites'], (result) => {
    let disabledSites = result.disabledSites || [];
    if (disable) {
      if (!disabledSites.includes(hostname)) disabledSites.push(hostname);
    } else {
      disabledSites = disabledSites.filter(h => h !== hostname);
    }
    chrome.storage.local.set({ disabledSites }, () => {
      showSiteFeedback('success',
        disable ? `Désactivé sur ${hostname}. Rechargez la page.`
                : `Activé sur ${hostname}. Rechargez la page.`
      );
    });
  });
}

// ─── Blocage GTM.js ───────────────────────────────────────────────────────────

const GTM_BLOCK_RULE_BASE_ID = 2000;

function hostnameToRuleId(hostname) {
  let hash = GTM_BLOCK_RULE_BASE_ID;
  for (let i = 0; i < hostname.length; i++) {
    hash = ((hash << 5) - hash) + hostname.charCodeAt(i);
    hash |= 0;
  }
  return (Math.abs(hash) % 7999) + 2001;
}

/**
 * Initialise les toggles de blocage, sélecteur GTM et mode live.
 */
function initBlockToggle(hostname, tabId) {
  if (!hostname) return;

  // Charger l'état courant depuis le storage
  chrome.storage.local.get(['blockedSites'], (result) => {
    const entry = normBlockEntry((result.blockedSites || {})[hostname]);
    setBlockToggleState(!!entry);

    if (entry) {
      showLiveModeRow(true);
      setLiveModeState(!!entry.liveMode);
      // Pré-sélectionner le GTM ID stocké (sera mis à jour quand les GTMs sont détectés)
      if (entry.gtmId) setSelectedGtmId(entry.gtmId);
    }

    updateBadge(!!entry, entry?.liveMode || false);
  });

  // Charger les GTMs détectés sur la page
  if (tabId) {
    chrome.runtime.sendMessage({ type: 'GET_DETECTED_GTMS', tabId }, (response) => {
      if (chrome.runtime.lastError) return;
      const ids = response?.ids || [];
      populateGtmSelector(ids, hostname);
    });
  }

  // Listener : toggle blocage
  blockToggle.addEventListener('change', () => {
    const shouldBlock = blockToggle.checked;
    setBlockToggleState(shouldBlock);
    showLiveModeRow(shouldBlock);
    if (!shouldBlock) setLiveModeState(false);
    updateBadge(shouldBlock, shouldBlock ? (liveToggle.checked) : false);
    updateBlockedSites(hostname, shouldBlock, liveToggle.checked, getSelectedGtmId());
  });

  // Listener : toggle live mode
  liveToggle.addEventListener('change', () => {
    setLiveModeState(liveToggle.checked);
    updateBadge(blockToggle.checked, liveToggle.checked);
    if (blockToggle.checked) {
      updateBlockedSites(hostname, true, liveToggle.checked, getSelectedGtmId());
    }
  });

  // Listener : changement de GTM ID sélectionné
  gtmIdSelect.addEventListener('change', () => {
    if (blockToggle.checked) {
      updateBlockedSites(hostname, true, liveToggle.checked, getSelectedGtmId());
    }
  });
}

function setBlockToggleState(blocked) {
  blockToggle.checked      = blocked;
  blockLabel.textContent   = blocked ? 'Activé'   : 'Désactivé';
  blockLabel.style.color   = blocked ? 'var(--orange)' : 'var(--text-dim)';
}

function setLiveModeState(live) {
  liveToggle.checked     = live;
  liveLabel.textContent  = live ? 'Activé'   : 'Désactivé';
  liveLabel.style.color  = live ? 'var(--red)' : 'var(--text-dim)';
}

function showLiveModeRow(visible) {
  liveModeRow.style.display = visible ? 'flex' : 'none';
}

function updateBadge(blocked, live) {
  if (blocked && live) {
    badgeMode.textContent = 'Live';
    badgeMode.className   = 'badge-mode live';
  } else {
    badgeMode.textContent = 'Dry-run';
    badgeMode.className   = 'badge-mode';
  }
}

// ─── Sélecteur GTM ID ─────────────────────────────────────────────────────────

function populateGtmSelector(ids, hostname) {
  if (!ids || ids.length === 0) {
    gtmSelectorRow.style.display = 'none';
    return;
  }

  // Vider les options existantes (garder "Tous les GTMs")
  while (gtmIdSelect.options.length > 1) {
    gtmIdSelect.remove(1);
  }

  // Ajouter les IDs détectés
  ids.forEach(id => {
    const opt = document.createElement('option');
    opt.value       = id;
    opt.textContent = id;
    gtmIdSelect.appendChild(opt);
  });

  gtmSelectorRow.style.display = 'block';

  // Pré-sélectionner selon l'état de blocage courant
  chrome.storage.local.get(['blockedSites', 'gtmContainer'], (result) => {
    const entry     = normBlockEntry((result.blockedSites || {})[hostname]);
    const storedId  = entry?.gtmId || '';

    if (storedId && ids.includes(storedId)) {
      setSelectedGtmId(storedId);
    } else {
      // Sinon, pré-sélectionner le publicId du conteneur importé si présent
      const pubId = result.gtmContainer?.containerVersion?.container?.publicId || '';
      if (pubId && ids.includes(pubId)) {
        setSelectedGtmId(pubId);
      }
    }
  });
}

function autoSelectGtmId(pubId) {
  for (const opt of gtmIdSelect.options) {
    if (opt.value === pubId) {
      gtmIdSelect.value = pubId;
      return;
    }
  }
}

function setSelectedGtmId(id) {
  gtmIdSelect.value = id || '';
}

function getSelectedGtmId() {
  return gtmIdSelect.value || null;
}

// ─── Mise à jour du blocage (storage + règle DNR) ─────────────────────────────

/**
 * Active ou désactive le blocage GTM pour un hostname.
 * @param {string}  hostname
 * @param {boolean} block
 * @param {boolean} liveMode
 * @param {string|null} gtmId - null = bloquer tous les GTMs
 */
function updateBlockedSites(hostname, block, liveMode, gtmId) {
  const ruleId = hostnameToRuleId(hostname);

  chrome.storage.local.get(['blockedSites'], (result) => {
    const blockedSites = result.blockedSites || {};

    if (block) {
      blockedSites[hostname] = { ruleId, gtmId: gtmId || null, liveMode: !!liveMode };
    } else {
      delete blockedSites[hostname];
    }

    chrome.storage.local.set({ blockedSites }, () => {
      const urlFilter = (block && gtmId)
        ? `||googletagmanager.com/gtm.js*id=${gtmId}`
        : '||googletagmanager.com/gtm.js';

      if (block) {
        // Supprimer l'ancienne règle puis ajouter la nouvelle (dans le même appel)
        chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: [ruleId],
          addRules: [{
            id: ruleId,
            priority: 1,
            action: { type: 'block' },
            condition: {
              urlFilter,
              initiatorDomains: [hostname],
              resourceTypes: ['script'],
            },
          }],
        }, () => {
          if (chrome.runtime.lastError) {
            showSiteFeedback('error', 'Erreur règle réseau : ' + chrome.runtime.lastError.message);
          } else {
            const label = gtmId ? `${gtmId} sur ${hostname}` : `GTM.js sur ${hostname}`;
            showSiteFeedback('success', `Blocage activé : ${label}. Rechargez la page.`);
          }
        });
      } else {
        chrome.declarativeNetRequest.updateDynamicRules({
          addRules: [],
          removeRuleIds: [ruleId],
        }, () => {
          showSiteFeedback('success', `GTM.js débloqué sur ${hostname}. Rechargez la page.`);
        });
      }
    });
  });
}

// ─── Feedbacks ────────────────────────────────────────────────────────────────

function showSiteFeedback(type, message) {
  if (!siteFeedback) return;
  siteFeedback.textContent = message;
  siteFeedback.className   = `feedback ${type}`;
  clearTimeout(showSiteFeedback._timer);
  showSiteFeedback._timer = setTimeout(() => {
    siteFeedback.className = 'feedback';
  }, 4000);
}

function showFeedback(type, message) {
  importFeedback.textContent = message;
  importFeedback.className   = `feedback ${type}`;
  clearTimeout(showFeedback._timer);
  showFeedback._timer = setTimeout(() => {
    importFeedback.className = 'feedback';
  }, 4000);
}

// ─── Bouton "Ouvrir DevTools" ─────────────────────────────────────────────────

btnOpenDevtools.addEventListener('click', () => {
  showFeedback('success', 'Appuyez sur F12 puis cliquez sur l\'onglet "GTM Preview".');
});

// ─── Initialisation ───────────────────────────────────────────────────────────

function init() {
  chrome.storage.local.get(['gtmContainer'], (result) => {
    if (result.gtmContainer?.containerVersion) {
      displayContainerInfo(result.gtmContainer.containerVersion);
    }
  });

  initSiteToggle();
}

init();
