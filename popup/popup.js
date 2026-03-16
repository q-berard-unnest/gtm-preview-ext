// ============================================================
// popup.js — Logique du popup GTM Preview
// ============================================================
// Rôle :
//   • Gérer l'import du fichier JSON d'export GTM
//   • Valider et stocker le JSON dans chrome.storage.local
//   • Afficher les infos du conteneur chargé
//   • Toggle d'activation/désactivation par site (hostname)
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
const siteFeedback       = document.getElementById('site-feedback');

// ─── Import JSON GTM ──────────────────────────────────────────────────────────

/** Ouvre le sélecteur de fichier */
btnImport.addEventListener('click', () => {
  fileInput.value = '';
  fileInput.click();
});

/** Traite le fichier sélectionné */
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
  reader.onerror = () => {
    showFeedback('error', 'Erreur lors de la lecture du fichier.');
  };
  reader.readAsText(file);
});

/**
 * Valide la structure du JSON d'export GTM et le stocke.
 * @param {Object} json - Le JSON parsé
 */
function validateAndStoreContainer(json) {
  // Vérification de la structure minimale attendue
  if (!json || typeof json !== 'object') {
    showFeedback('error', 'Structure JSON non reconnue.');
    return;
  }

  // Format export GTM : { exportFormatVersion, containerVersion: { tag, trigger, variable, ... } }
  if (!json.containerVersion) {
    showFeedback('error', 'Clé "containerVersion" manquante. Vérifiez que c\'est bien un export GTM.');
    return;
  }

  const cv = json.containerVersion;

  // Infos minimales
  const name   = cv.container?.name || cv.name || 'Inconnu';
  const pubId  = cv.container?.publicId || '';
  const nbTags = (cv.tag || []).length;
  const nbTrigs = (cv.trigger || []).length;
  const nbVars  = (cv.variable || []).length;

  // Stocker dans chrome.storage.local
  chrome.storage.local.set({ gtmContainer: json }, () => {
    if (chrome.runtime.lastError) {
      showFeedback('error', 'Erreur de stockage : ' + chrome.runtime.lastError.message);
      return;
    }

    showFeedback('success',
      `Conteneur "${name}" chargé — ${nbTags} tags, ${nbTrigs} triggers, ${nbVars} variables`
    );
    displayContainerInfo(cv);
  });
}

// ─── Affichage des infos conteneur ───────────────────────────────────────────

/**
 * Affiche les informations du conteneur dans la carte UI.
 * @param {Object} cv - containerVersion
 */
function displayContainerInfo(cv) {
  const name    = cv.container?.name || cv.name || 'Inconnu';
  const pubId   = cv.container?.publicId || '—';
  const version = cv.containerVersionId || '0';
  const nbTags  = (cv.tag || []).length;

  containerEmpty.style.display  = 'none';
  containerLoaded.style.display = 'block';
  btnClearContainer.style.display = 'block';

  containerName.textContent    = name;
  containerId.textContent      = pubId;
  containerVersion.textContent = `v${version}`;
  containerTags.textContent    = `${nbTags} tag${nbTags !== 1 ? 's' : ''}`;
}

/**
 * Efface le conteneur chargé.
 */
btnClearContainer.addEventListener('click', () => {
  chrome.storage.local.remove(['gtmContainer'], () => {
    containerEmpty.style.display  = 'block';
    containerLoaded.style.display = 'none';
    btnClearContainer.style.display = 'none';
    showFeedback('success', 'Conteneur supprimé.');
  });
});

// ─── Toggle par site ──────────────────────────────────────────────────────────

/**
 * Récupère l'onglet actif et initialise le toggle.
 */
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

    // Pages internes Chrome non supportées
    if (!hostname || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      siteHostname.textContent = '(page interne Chrome)';
      siteToggle.disabled = true;
      return;
    }

    siteHostname.textContent = hostname;
    siteHostname.title = tab.url;

    // Lire l'état courant
    chrome.storage.local.get(['disabledSites'], (result) => {
      const disabledSites = result.disabledSites || [];
      const isEnabled = !disabledSites.includes(hostname);
      setSiteToggleState(isEnabled);
    });

    // Écouter les changements du toggle d'activation
    siteToggle.addEventListener('change', () => {
      const isEnabled = siteToggle.checked;
      setSiteToggleState(isEnabled);
      updateDisabledSites(hostname, !isEnabled);
    });

    // Initialiser le toggle de blocage GTM
    initBlockToggle(hostname);
  });
}

/**
 * Met à jour visuellement l'état du toggle.
 * @param {boolean} enabled
 */
function setSiteToggleState(enabled) {
  siteToggle.checked = enabled;
  toggleLabel.textContent = enabled ? 'Activé' : 'Désactivé';
  toggleLabel.style.color = enabled ? 'var(--green)' : 'var(--text-dim)';
}

/**
 * Ajoute ou retire un hostname de la liste des sites désactivés.
 * @param {string}  hostname
 * @param {boolean} disable  - true = désactiver, false = activer
 */
function updateDisabledSites(hostname, disable) {
  chrome.storage.local.get(['disabledSites'], (result) => {
    let disabledSites = result.disabledSites || [];
    if (disable) {
      if (!disabledSites.includes(hostname)) {
        disabledSites.push(hostname);
      }
    } else {
      disabledSites = disabledSites.filter(h => h !== hostname);
    }
    chrome.storage.local.set({ disabledSites }, () => {
      showSiteFeedback(
        'success',
        disable
          ? `Désactivé sur ${hostname}. Rechargez la page.`
          : `Activé sur ${hostname}. Rechargez la page.`
      );
    });
  });
}

// ─── Blocage GTM.js ───────────────────────────────────────────────────────────

/** ID de la règle declarativeNetRequest utilisée pour bloquer GTM.js */
const GTM_BLOCK_RULE_BASE_ID = 2000;

/**
 * Génère un ID de règle stable basé sur le hostname
 * (déterministe pour pouvoir le retrouver sans storage supplémentaire).
 */
function hostnameToRuleId(hostname) {
  let hash = GTM_BLOCK_RULE_BASE_ID;
  for (let i = 0; i < hostname.length; i++) {
    hash = ((hash << 5) - hash) + hostname.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }
  // Garder dans une plage sûre [2001, 9999]
  return (Math.abs(hash) % 7999) + 2001;
}

/**
 * Initialise le toggle de blocage GTM.
 * @param {string} hostname
 */
function initBlockToggle(hostname) {
  if (!hostname || !blockToggle) return;

  chrome.storage.local.get(['blockedSites'], (result) => {
    const blockedSites = result.blockedSites || {};
    setBlockToggleState(!!blockedSites[hostname]);
  });

  blockToggle.addEventListener('change', () => {
    const shouldBlock = blockToggle.checked;
    setBlockToggleState(shouldBlock);
    updateBlockedSites(hostname, shouldBlock);
  });
}

/**
 * Met à jour l'état visuel du toggle de blocage.
 * @param {boolean} blocked
 */
function setBlockToggleState(blocked) {
  blockToggle.checked = blocked;
  blockLabel.textContent = blocked ? 'Activé' : 'Désactivé';
  blockLabel.style.color = blocked ? 'var(--orange)' : 'var(--text-dim)';
}

/**
 * Active ou désactive le blocage GTM pour un hostname.
 * Ajoute ou supprime une règle declarativeNetRequest.
 * @param {string}  hostname
 * @param {boolean} block
 */
function updateBlockedSites(hostname, block) {
  const ruleId = hostnameToRuleId(hostname);

  chrome.storage.local.get(['blockedSites'], (result) => {
    const blockedSites = result.blockedSites || {};

    if (block) {
      blockedSites[hostname] = ruleId;
    } else {
      delete blockedSites[hostname];
    }

    chrome.storage.local.set({ blockedSites }, () => {
      // Synchroniser la règle declarativeNetRequest
      if (block) {
        chrome.declarativeNetRequest.updateDynamicRules({
          addRules: [{
            id: ruleId,
            priority: 1,
            action: { type: 'block' },
            condition: {
              urlFilter: '||googletagmanager.com/gtm.js',
              initiatorDomains: [hostname],
              resourceTypes: ['script'],
            },
          }],
          removeRuleIds: [],
        }, () => {
          if (chrome.runtime.lastError) {
            showSiteFeedback('error', 'Erreur règle réseau : ' + chrome.runtime.lastError.message);
          } else {
            showSiteFeedback('success', `GTM.js bloqué sur ${hostname}. Rechargez la page.`);
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

/**
 * Affiche un feedback dans la section site.
 * @param {'success'|'error'} type
 * @param {string}            message
 */
function showSiteFeedback(type, message) {
  if (!siteFeedback) return;
  siteFeedback.textContent = message;
  siteFeedback.className   = `feedback ${type}`;
  clearTimeout(showSiteFeedback._timer);
  showSiteFeedback._timer = setTimeout(() => {
    siteFeedback.className = 'feedback';
  }, 4000);
}

// ─── Bouton "Ouvrir DevTools" ─────────────────────────────────────────────────

// Note : Chrome ne permet pas d'ouvrir les DevTools programmatiquement depuis un popup.
// On informe simplement l'utilisateur.
btnOpenDevtools.addEventListener('click', () => {
  showFeedback('success', 'Appuyez sur F12 puis cliquez sur l\'onglet "GTM Preview".');
});

// ─── Feedback utilisateur ─────────────────────────────────────────────────────

/**
 * Affiche un message de feedback temporaire.
 * @param {'success'|'error'} type
 * @param {string}            message
 */
function showFeedback(type, message) {
  importFeedback.textContent  = message;
  importFeedback.className    = `feedback ${type}`;

  // Masquer après 4 secondes
  clearTimeout(showFeedback._timer);
  showFeedback._timer = setTimeout(() => {
    importFeedback.className = 'feedback';
  }, 4000);
}

// ─── Initialisation ───────────────────────────────────────────────────────────

/**
 * Au chargement du popup : lire l'état courant depuis le storage.
 */
function init() {
  // Charger le conteneur déjà stocké (s'il existe)
  chrome.storage.local.get(['gtmContainer'], (result) => {
    if (result.gtmContainer?.containerVersion) {
      displayContainerInfo(result.gtmContainer.containerVersion);
    }
  });

  // Initialiser le toggle du site actuel
  initSiteToggle();
}

init();
