// ============================================================
// injected.js — Hook dataLayer dans le contexte de la page
// ============================================================
// Ce script s'exécute DANS le contexte window de la page,
// ce qui lui permet d'accéder au vrai window.dataLayer.
//
// Rôle :
//   • Intercepter tous les appels à dataLayer.push()
//   • Capturer les éléments déjà présents dans le dataLayer
//   • Gérer le cas où GTM remplace le tableau dataLayer
//   • Envoyer chaque événement au content script via postMessage
// ============================================================

(function () {
  'use strict';

  // ─── Garde contre la double injection ─────────────────────────────────────

  if (window.__gtmPreviewInjected) return;
  window.__gtmPreviewInjected = true;

  // ─── Compteur d'événements ────────────────────────────────────────────────

  /** Identifiant unique incrémental pour chaque événement capturé */
  let eventCounter = 0;

  // ─── Sérialisation sécurisée ──────────────────────────────────────────────

  /**
   * Sérialise un objet en JSON en gérant les références circulaires,
   * les fonctions et les objets non-sérialisables.
   * @param {*} obj
   * @returns {*} Objet sérialisable
   */
  function safeSerialize(obj) {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== 'object' && typeof obj !== 'function') return obj;

    try {
      const seen = new WeakSet();
      return JSON.parse(JSON.stringify(obj, (key, value) => {
        if (typeof value === 'function') {
          return '[Function: ' + (value.name || 'anonymous') + ']';
        }
        if (typeof value === 'object' && value !== null) {
          // Éléments DOM → représentation compacte (évite la sérialisation récursive infinie)
          if (typeof value.nodeType === 'number' && typeof value.tagName === 'string') {
            const tag = value.tagName;
            const id  = value.id      ? '#' + value.id      : '';
            const cls = value.className ? '.' + String(value.className).trim().split(/\s+/)[0] : '';
            return `[Element: ${tag}${id}${cls}]`;
          }
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
        }
        // Ignorer les clés internes GTM Preview
        if (key === '_gtmPreviewHooked') return undefined;
        return value;
      }));
    } catch (e) {
      return { _serializeError: e.message, _type: typeof obj };
    }
  }

  // ─── Capture du contexte page ────────────────────────────────────────────

  /**
   * Capture l'état courant de la page pour la résolution des variables GTM.
   * Appelé au moment du push (pas à l'injection) pour avoir des valeurs fraîches
   * (important pour les SPAs qui changent d'URL sans rechargement complet).
   * @returns {Object}
   */
  function getPageContext() {
    return {
      pageUrl:      window.location.href,
      pageHostname: window.location.hostname,
      pagePath:     window.location.pathname,
      pageQuery:    window.location.search,
      pageFragment: window.location.hash,
      referrer:     document.referrer,
    };
  }

  // ─── Envoi des événements au content script ───────────────────────────────

  /**
   * Envoie un événement dataLayer au content script via postMessage.
   * @param {*}       payload   - L'objet pushé dans le dataLayer
   * @param {number}  index     - Index dans le tableau dataLayer
   * @param {boolean} isInitial - true si l'élément était déjà présent avant le hook
   */
  function sendEvent(payload, index, isInitial) {
    window.postMessage({
      source:      'gtm-preview-injected',
      type:        'DATALAYER_PUSH',
      id:          ++eventCounter,
      timestamp:   Date.now(),
      payload:     safeSerialize(payload),
      index:       index,
      isInitial:   isInitial || false,
      pageContext:  getPageContext(),   // Contexte page pour résolution des variables
    }, '*');
  }

  // ─── Création d'un push hooké ─────────────────────────────────────────────

  /**
   * Remplace la méthode push d'un tableau dataLayer par une version
   * qui intercepte les appels et notifie notre extension.
   * @param {Array} arr - Le tableau dataLayer à hooker
   */
  function hookPush(arr) {
    if (!arr || arr._gtmPreviewHooked) return;

    const nativePush = Array.prototype.push;

    arr.push = function (...args) {
      // Appel du push natif (ou de la version GTM si elle a déjà été installée)
      const result = nativePush.apply(this, args);

      // Intercepter chaque argument (on peut pousser plusieurs objets à la fois)
      args.forEach((item) => {
        if (item !== null && item !== undefined) {
          sendEvent(item, this.length - 1, false);
        }
      });

      return result;
    };

    arr._gtmPreviewHooked = true;
  }

  // ─── Initialisation du hook ───────────────────────────────────────────────

  /**
   * Installe le hook sur window.dataLayer.
   * Gère les cas :
   *   1. dataLayer n'existe pas encore (créé par ce script)
   *   2. dataLayer existe déjà (éléments pré-chargés à rejouer)
   *   3. GTM remplace dataLayer après notre hook (Object.defineProperty)
   */
  function hookDataLayer() {
    // Capturer les éléments déjà présents AVANT notre hook
    const existingItems = Array.isArray(window.dataLayer)
      ? [...window.dataLayer]
      : [];

    // Créer ou réutiliser le tableau
    window.dataLayer = window.dataLayer || [];

    // Hooker la méthode push du tableau courant
    hookPush(window.dataLayer);

    // Surveiller le remplacement de window.dataLayer (GTM remplace parfois le tableau)
    let _internalDataLayer = window.dataLayer;

    try {
      Object.defineProperty(window, 'dataLayer', {
        get() {
          return _internalDataLayer;
        },
        set(newValue) {
          _internalDataLayer = newValue;
          // Re-hooker le nouveau tableau
          if (Array.isArray(newValue)) {
            hookPush(newValue);
          }
        },
        configurable: true  // Permet à GTM de reconfgurer si nécessaire
      });
    } catch (e) {
      // Sur certaines pages, defineProperty peut échouer (ex : pages avec CSP strict)
      // On continue sans la surveillance du remplacement
      console.warn('[GTM Preview] Impossible de surveiller le remplacement de dataLayer:', e.message);
    }

    // Rejouer les éléments déjà présents (marqués isInitial: true)
    existingItems.forEach((item, index) => {
      if (item !== null && item !== undefined) {
        sendEvent(item, index, true);
      }
    });
  }

  // ─── Hooks d'événements synthétiques (Phase 5) ───────────────────────────

  /**
   * Initialise les hooks click, form, scroll et historique.
   * Ces hooks ne poussent dans le dataLayer QUE si GTM n'est pas détecté
   * sur la page, pour éviter les doublons avec GTM natif.
   * La détection se fait au moment de l'événement (lazy) car GTM charge
   * de façon asynchrone après notre injection.
   */
  function initSyntheticHooks() {

    // ─ Click & Link Click ──────────────────────────────────────────────────
    document.addEventListener('click', function (e) {
      if (window.google_tag_manager) return;

      const el      = e.target;
      // Remonter vers le premier ancêtre <a> (incluant l'élément lui-même)
      const linkEl  = el.closest ? el.closest('a') : null;
      const isLink  = !!linkEl;

      window.dataLayer.push({
        event:                  isLink ? 'gtm.linkClick' : 'gtm.click',
        'gtm.element':          el.tagName + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).trim().split(/\s+/)[0] : ''),
        'gtm.elementClasses':   String(el.className  || ''),
        'gtm.elementId':        String(el.id          || ''),
        'gtm.elementTarget':    String(linkEl?.target || ''),
        'gtm.elementUrl':       String(linkEl?.href   || ''),
        'gtm.elementText':      (el.textContent || '').trim().slice(0, 100),
        'gtm.uniqueEventId':    ++eventCounter,
        '__gtmPreviewSynthetic': true,
      });
    }, true);

    // ─ Form Submit ────────────────────────────────────────────────────────
    document.addEventListener('submit', function (e) {
      if (window.google_tag_manager) return;

      const form = e.target;
      window.dataLayer.push({
        event:                  'gtm.formSubmit',
        'gtm.element':          form.tagName + (form.id ? '#' + form.id : ''),
        'gtm.elementClasses':   String(form.className || ''),
        'gtm.elementId':        String(form.id         || ''),
        'gtm.elementTarget':    String(form.target     || ''),
        'gtm.elementUrl':       String(form.action     || window.location.href),
        'gtm.elementText':      '',
        'gtm.uniqueEventId':    ++eventCounter,
        '__gtmPreviewSynthetic': true,
      });
    }, true);

    // ─ Scroll Depth ───────────────────────────────────────────────────────
    const SCROLL_MILESTONES = [25, 50, 75, 90, 100];
    const scrollFired = new Set();
    let scrollTimer   = null;

    function checkScrollDepth() {
      if (window.google_tag_manager) return;
      const doc         = document.documentElement;
      const scrollable  = doc.scrollHeight - doc.clientHeight;
      const pct         = scrollable > 0
        ? Math.floor(doc.scrollTop / scrollable * 100)
        : 100;

      for (const milestone of SCROLL_MILESTONES) {
        if (pct >= milestone && !scrollFired.has(milestone)) {
          scrollFired.add(milestone);
          window.dataLayer.push({
            event:                   'gtm.scrollDepth',
            'gtm.scrollThreshold':   milestone,
            'gtm.scrollUnits':       'percent',
            'gtm.scrollDirection':   'vertical',
            'gtm.uniqueEventId':     ++eventCounter,
            '__gtmPreviewSynthetic': true,
          });
        }
      }
    }

    window.addEventListener('scroll', function () {
      if (scrollTimer) return;
      scrollTimer = setTimeout(function () {
        scrollTimer = null;
        checkScrollDepth();
      }, 200);
    }, { passive: true });

    // ─ History Change ─────────────────────────────────────────────────────
    const _origPushState    = history.pushState.bind(history);
    const _origReplaceState = history.replaceState.bind(history);

    function pushHistoryChange(source, oldUrl, newState) {
      if (window.google_tag_manager) return;
      const newUrl = window.location.href;
      window.dataLayer.push({
        event:                      'gtm.historyChange',
        'gtm.historyChangeSource':  source,
        'gtm.oldUrlFragment':       (oldUrl.split('#')[1] || ''),
        'gtm.newUrlFragment':       (newUrl.split('#')[1] || ''),
        'gtm.oldHistoryState':      null,
        'gtm.newHistoryState':      newState || null,
        'gtm.uniqueEventId':        ++eventCounter,
        '__gtmPreviewSynthetic':    true,
      });
    }

    history.pushState = function (state, title, url) {
      const oldUrl = window.location.href;
      const result = _origPushState(state, title, url);
      pushHistoryChange('pushState', oldUrl, state);
      return result;
    };

    history.replaceState = function (state, title, url) {
      const oldUrl = window.location.href;
      const result = _origReplaceState(state, title, url);
      pushHistoryChange('replaceState', oldUrl, state);
      return result;
    };

    window.addEventListener('popstate', function (e) {
      if (window.google_tag_manager) return;
      pushHistoryChange('popstate', window.location.href, e.state);
    });
  }

  // ─── Simulation du cycle de vie GTM (mode blocage) ───────────────────────

  /**
   * Lorsque GTM.js est bloqué par l'extension, simule les événements
   * de cycle de vie que GTM pousserait normalement :
   *   gtm.init_consent → gtm.init → gtm.js → gtm.dom → gtm.load
   *
   * Appelé uniquement si window.__gtmPreviewBlockMode === true,
   * c'est-à-dire si le content script a injecté le flag de blocage.
   */
  function simulateGtmLifecycle() {
    const gtmStart = Date.now();

    // Phase d'initialisation (synchrone, avant tout tag)
    window.dataLayer.push({ event: 'gtm.init_consent', 'gtm.uniqueEventId': ++eventCounter });
    window.dataLayer.push({ event: 'gtm.init',         'gtm.uniqueEventId': ++eventCounter });
    window.dataLayer.push({ event: 'gtm.js', 'gtm.start': gtmStart, 'gtm.uniqueEventId': ++eventCounter });

    // DOM Ready
    function pushDom() {
      window.dataLayer.push({ event: 'gtm.dom', 'gtm.uniqueEventId': ++eventCounter });
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', pushDom, { once: true });
    } else {
      pushDom();
    }

    // Window Loaded
    function pushLoad() {
      window.dataLayer.push({ event: 'gtm.load', 'gtm.uniqueEventId': ++eventCounter });
    }
    if (document.readyState === 'complete') {
      pushLoad();
    } else {
      window.addEventListener('load', pushLoad, { once: true });
    }
  }

  // ─── Détection des IDs GTM sur la page ────────────────────────────────────

  /**
   * Scanne la page pour trouver les IDs de conteneurs GTM/GA4 :
   *   1. window.google_tag_manager  (GTMs déjà chargés)
   *   2. <script src="...gtm.js?id=...">  (balises présentes même si le JS est bloqué)
   * Envoie GTM_IDS_DETECTED au content script via postMessage.
   */
  function detectGtmIds() {
    const ids = new Set();

    // GTMs chargés (présents dans l'objet global de GTM)
    if (window.google_tag_manager && typeof window.google_tag_manager === 'object') {
      Object.keys(window.google_tag_manager).forEach(function(key) {
        if (/^[A-Z]{2,5}-[A-Z0-9]+$/.test(key)) ids.add(key);
      });
    }

    // Balises <script src="...googletagmanager.com/gtm.js?id=GTM-XXXXXX">
    document.querySelectorAll('script[src*="googletagmanager.com/gtm.js"]').forEach(function(s) {
      try {
        var url = new URL(s.src);
        var id = url.searchParams.get('id');
        if (id) ids.add(id);
      } catch (e) {}
    });

    if (ids.size > 0) {
      window.postMessage({
        source: 'gtm-preview-injected',
        type:   'GTM_IDS_DETECTED',
        ids:    Array.from(ids),
      }, '*');
    }
  }

  // ─── Démarrage ────────────────────────────────────────────────────────────

  hookDataLayer();
  if (window.__gtmPreviewBlockMode) simulateGtmLifecycle();
  initSyntheticHooks();

  // Détecter les GTMs immédiatement puis après chargement asynchrone
  detectGtmIds();
  setTimeout(detectGtmIds, 1500);
  setTimeout(detectGtmIds, 4000);

  console.log('[GTM Preview] dataLayer hooké avec succès');

})();
