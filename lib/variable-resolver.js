// ============================================================
// lib/variable-resolver.js — Résolution des variables GTM
// ============================================================
// Résout les références {{Variable Name}} dans les templates GTM.
//
// Types supportés (Phase 3 — complet) :
//   Server-side (service worker)  :
//     c    Constante
//     v    Data Layer Variable (dot-path)
//     u    URL (composants)
//     smm  Lookup Table
//     remm RegEx Table
//     Built-ins : Page URL, Page Path, Event, Referrer, Container ID,
//                 Click/Form/Scroll built-ins (depuis mergedDataLayer)
//
//   Client-side (évaluation dans la page via DevTools) :
//     j    JavaScript Variable  → { __gtmPreviewPageEval: true, code }
//     jsm  Custom JavaScript    → { __gtmPreviewPageEval: true, code }
//     d    DOM Element          → { __gtmPreviewPageEval: true, code }
//     k    1st Party Cookie     → { __gtmPreviewPageEval: true, code }
//     aev  Auto-Event Variable  → depuis mergedDataLayer ou PageEval
// ============================================================

'use strict';

// ─── Marqueur "nécessite évaluation page" ─────────────────────────────────────

/**
 * Clé spéciale utilisée pour signaler qu'une variable nécessite
 * d'être évaluée dans le contexte de la page (via chrome.devtools.inspectedWindow.eval).
 * Compatible avec la sérialisation JSON (contrairement aux Symbols).
 */
export const PAGE_EVAL_MARKER = '__gtmPreviewPageEval';

/**
 * Crée un objet "page eval" avec le code JS à exécuter dans la page.
 * @param {string} code - Expression JS à évaluer
 * @returns {{ __gtmPreviewPageEval: true, code: string }}
 */
function pageEval(code) {
  return { [PAGE_EVAL_MARKER]: true, code };
}

/**
 * Vérifie si une valeur est un marqueur "page eval".
 * @param {*} value
 * @returns {boolean}
 */
export function isPageEval(value) {
  return value !== null && typeof value === 'object' && value[PAGE_EVAL_MARKER] === true;
}

// ─── Variables built-in GTM → résolveurs runtime ──────────────────────────────

/**
 * Map des built-ins GTM (par type ET par nom) vers leur valeur runtime.
 * Toutes les clés liées aux clicks/forms/scroll lisent depuis mergedDataLayer
 * car GTM y pousse ces valeurs avant d'évaluer les tags.
 */
const BUILT_IN_RESOLVERS = {
  // ── Événement ─────────────────────────────────────────────────────────────
  'EVENT':         ctx => ctx.eventName,
  'Event':         ctx => ctx.eventName,
  '_event':        ctx => ctx.eventName,

  // ── Page ──────────────────────────────────────────────────────────────────
  'PAGE_URL':      ctx => ctx.pageUrl,
  'Page URL':      ctx => ctx.pageUrl,
  'PAGE_HOSTNAME': ctx => ctx.pageHostname,
  'Page Hostname': ctx => ctx.pageHostname,
  'PAGE_PATH':     ctx => ctx.pagePath,
  'Page Path':     ctx => ctx.pagePath,
  'QUERY_STRING':  ctx => (ctx.pageQuery    || '').replace(/^\?/, ''),
  'Query String':  ctx => (ctx.pageQuery    || '').replace(/^\?/, ''),
  'PAGE_FRAGMENT': ctx => (ctx.pageFragment || '').replace(/^#/, ''),
  'Fragment':      ctx => (ctx.pageFragment || '').replace(/^#/, ''),

  // ── Referrer ──────────────────────────────────────────────────────────────
  'REFERRER':      ctx => ctx.referrer,
  'Referrer':      ctx => ctx.referrer,

  // ── Numéro aléatoire ──────────────────────────────────────────────────────
  'RANDOM_NUMBER': () => Math.floor(Math.random() * 2147483647),
  'Random Number': () => Math.floor(Math.random() * 2147483647),

  // ── Clicks ────────────────────────────────────────────────────────────────
  // Lecture dans le payload courant en priorité (c'est là que GTM pousse les
  // données de clic), puis fallback sur le mergedDataLayer.
  'CLICK_ELEMENT':  ctx => ctx.payload?.['gtm.element']       ?? ctx.mergedDataLayer?.['gtm.element'],
  'Click Element':  ctx => ctx.payload?.['gtm.element']       ?? ctx.mergedDataLayer?.['gtm.element'],
  'CLICK_CLASSES':  ctx => ctx.payload?.['gtm.elementClasses'] ?? ctx.mergedDataLayer?.['gtm.elementClasses'],
  'Click Classes':  ctx => ctx.payload?.['gtm.elementClasses'] ?? ctx.mergedDataLayer?.['gtm.elementClasses'],
  'CLICK_ID':       ctx => ctx.payload?.['gtm.elementId']      ?? ctx.mergedDataLayer?.['gtm.elementId'],
  'Click ID':       ctx => ctx.payload?.['gtm.elementId']      ?? ctx.mergedDataLayer?.['gtm.elementId'],
  'CLICK_TARGET':   ctx => ctx.payload?.['gtm.elementTarget']  ?? ctx.mergedDataLayer?.['gtm.elementTarget'],
  'Click Target':   ctx => ctx.payload?.['gtm.elementTarget']  ?? ctx.mergedDataLayer?.['gtm.elementTarget'],
  'CLICK_URL':      ctx => ctx.payload?.['gtm.elementUrl']     ?? ctx.mergedDataLayer?.['gtm.elementUrl'],
  'Click URL':      ctx => ctx.payload?.['gtm.elementUrl']     ?? ctx.mergedDataLayer?.['gtm.elementUrl'],
  'CLICK_TEXT':     ctx => ctx.payload?.['gtm.elementText']    ?? ctx.mergedDataLayer?.['gtm.elementText'],
  'Click Text':     ctx => ctx.payload?.['gtm.elementText']    ?? ctx.mergedDataLayer?.['gtm.elementText'],

  // ── Formulaires ───────────────────────────────────────────────────────────
  'FORM_CLASSES':   ctx => ctx.payload?.['gtm.elementClasses'] ?? ctx.mergedDataLayer?.['gtm.elementClasses'],
  'Form Classes':   ctx => ctx.payload?.['gtm.elementClasses'] ?? ctx.mergedDataLayer?.['gtm.elementClasses'],
  'FORM_ELEMENT':   ctx => ctx.payload?.['gtm.element']        ?? ctx.mergedDataLayer?.['gtm.element'],
  'Form Element':   ctx => ctx.payload?.['gtm.element']        ?? ctx.mergedDataLayer?.['gtm.element'],
  'FORM_ID':        ctx => ctx.payload?.['gtm.elementId']      ?? ctx.mergedDataLayer?.['gtm.elementId'],
  'Form ID':        ctx => ctx.payload?.['gtm.elementId']      ?? ctx.mergedDataLayer?.['gtm.elementId'],
  'FORM_TARGET':    ctx => ctx.payload?.['gtm.elementTarget']  ?? ctx.mergedDataLayer?.['gtm.elementTarget'],
  'Form Target':    ctx => ctx.payload?.['gtm.elementTarget']  ?? ctx.mergedDataLayer?.['gtm.elementTarget'],
  'FORM_TEXT':      ctx => ctx.payload?.['gtm.elementText']    ?? ctx.mergedDataLayer?.['gtm.elementText'],
  'Form Text':      ctx => ctx.payload?.['gtm.elementText']    ?? ctx.mergedDataLayer?.['gtm.elementText'],
  'FORM_URL':       ctx => ctx.payload?.['gtm.elementUrl']     ?? ctx.mergedDataLayer?.['gtm.elementUrl'],
  'Form URL':       ctx => ctx.payload?.['gtm.elementUrl']     ?? ctx.mergedDataLayer?.['gtm.elementUrl'],

  // ── Scroll Depth ──────────────────────────────────────────────────────────
  'SCROLL_DEPTH_THRESHOLD': ctx => ctx.payload?.['gtm.scrollThreshold']  ?? ctx.mergedDataLayer?.['gtm.scrollThreshold'],
  'Scroll Depth Threshold': ctx => ctx.payload?.['gtm.scrollThreshold']  ?? ctx.mergedDataLayer?.['gtm.scrollThreshold'],
  'SCROLL_DEPTH_UNITS':     ctx => ctx.payload?.['gtm.scrollUnits']      ?? ctx.mergedDataLayer?.['gtm.scrollUnits'],
  'Scroll Depth Units':     ctx => ctx.payload?.['gtm.scrollUnits']      ?? ctx.mergedDataLayer?.['gtm.scrollUnits'],
  'SCROLL_DIRECTION':       ctx => ctx.payload?.['gtm.scrollDirection']  ?? ctx.mergedDataLayer?.['gtm.scrollDirection'],
  'Scroll Direction':       ctx => ctx.payload?.['gtm.scrollDirection']  ?? ctx.mergedDataLayer?.['gtm.scrollDirection'],

  // ── Visibilité ────────────────────────────────────────────────────────────
  'ELEMENT_VISIBILITY_RATIO':            ctx => ctx.payload?.['gtm.visibleRatio']   ?? ctx.mergedDataLayer?.['gtm.visibleRatio'],
  'Element Visibility Ratio':            ctx => ctx.payload?.['gtm.visibleRatio']   ?? ctx.mergedDataLayer?.['gtm.visibleRatio'],
  'ELEMENT_VISIBILITY_TIME':             ctx => ctx.payload?.['gtm.visibleTime']    ?? ctx.mergedDataLayer?.['gtm.visibleTime'],
  'Element Visibility Time':             ctx => ctx.payload?.['gtm.visibleTime']    ?? ctx.mergedDataLayer?.['gtm.visibleTime'],
  'ELEMENT_VISIBILITY_RECENTLY_VISIBLE': ctx => ctx.payload?.['gtm.recentlyVisible'] ?? ctx.mergedDataLayer?.['gtm.recentlyVisible'],

  // ── Historique (SPA) ──────────────────────────────────────────────────────
  'HISTORY_SOURCE':       ctx => ctx.payload?.['gtm.historyChangeSource'] ?? ctx.mergedDataLayer?.['gtm.historyChangeSource'],
  'History Source':       ctx => ctx.payload?.['gtm.historyChangeSource'] ?? ctx.mergedDataLayer?.['gtm.historyChangeSource'],
  'NEW_HISTORY_FRAGMENT': ctx => ctx.payload?.['gtm.newHistoryFragment']  ?? ctx.mergedDataLayer?.['gtm.newHistoryFragment'],
  'Old History Fragment': ctx => ctx.payload?.['gtm.oldHistoryFragment']  ?? ctx.mergedDataLayer?.['gtm.oldHistoryFragment'],
  'New History Fragment': ctx => ctx.payload?.['gtm.newHistoryFragment']  ?? ctx.mergedDataLayer?.['gtm.newHistoryFragment'],
  'New History State':    ctx => ctx.payload?.['gtm.newHistoryState']     ?? ctx.mergedDataLayer?.['gtm.newHistoryState'],
  'Old History State':    ctx => ctx.payload?.['gtm.oldHistoryState']     ?? ctx.mergedDataLayer?.['gtm.oldHistoryState'],
};

// ─── Classe principale ───────────────────────────────────────────────────────

export class VariableResolver {
  /**
   * @param {ParsedContainer} parsedContainer
   */
  constructor(parsedContainer) {
    this.meta             = parsedContainer.meta;
    this.variables        = parsedContainer.variables;
    this.variablesByName  = parsedContainer.variablesByName;
    this.builtInVariables = parsedContainer.builtInVariables;
  }

  // ─── Résolution d'un template ──────────────────────────────────────────────

  /**
   * Résout toutes les références {{Variable}} dans un template string.
   * Note : les valeurs PAGE_EVAL (jsm, j, d, k) ne peuvent pas être inlinées
   * dans un template — elles sont retournées comme marqueur si c'est la
   * seule variable du template, ignorées sinon.
   *
   * @param {*}      templateValue  - Valeur brute (peut contenir {{Var}})
   * @param {Object} context
   * @returns {*}
   */
  resolveTemplate(templateValue, context) {
    if (typeof templateValue !== 'string') return templateValue;

    // Cas simple : le template n'est qu'une seule variable → retourner la valeur telle quelle
    const singleVarMatch = templateValue.match(/^\{\{([^}]+)\}\}$/);
    if (singleVarMatch) {
      return this.resolveVarName(singleVarMatch[1].trim(), context);
    }

    // Cas général : interpolation dans une chaîne
    // Les variables PAGE_EVAL ne peuvent pas être interpolées → on garde le placeholder
    return templateValue.replace(/\{\{([^}]+)\}\}/g, (match, varName) => {
      const resolved = this.resolveVarName(varName.trim(), context);
      if (resolved === undefined || resolved === null) return match;
      if (isPageEval(resolved)) return match; // ne peut pas être inliné
      return String(resolved);
    });
  }

  // ─── Résolution par nom ────────────────────────────────────────────────────

  /**
   * Résout une variable GTM par son nom.
   * @param {string} name
   * @param {Object} context
   * @returns {*}
   */
  resolveVarName(name, context) {
    // 1. Built-ins hard-codés (Page URL, _event, etc.)
    if (Object.prototype.hasOwnProperty.call(BUILT_IN_RESOLVERS, name)) {
      return BUILT_IN_RESOLVERS[name](context);
    }

    // 2. Métadonnées du conteneur
    if (name === 'Container ID')      return this.meta.publicId;
    if (name === 'Container Version') return this.meta.version;
    if (name === 'Environment Name')  return 'GTM Preview (simulation)';
    if (name === 'HTML ID')           return this.meta.publicId;

    // 3. Built-ins déclarés dans le conteneur (par leur nom affiché)
    const builtIn = this.builtInVariables.get(name);
    if (builtIn) return this._resolveBuiltInByType(builtIn.type, context);

    // 4. Variables utilisateur
    const userVar = this.variablesByName.get(name);
    if (userVar) return this._resolveUserVariable(userVar, context);

    return undefined;
  }

  // ─── Built-in par type ────────────────────────────────────────────────────

  _resolveBuiltInByType(type, context) {
    if (Object.prototype.hasOwnProperty.call(BUILT_IN_RESOLVERS, type)) {
      return BUILT_IN_RESOLVERS[type](context);
    }
    return undefined;
  }

  // ─── Variables utilisateur ────────────────────────────────────────────────

  /**
   * Résout une variable utilisateur GTM selon son type.
   * Les types client-side retournent un marqueur PAGE_EVAL.
   */
  _resolveUserVariable(variable, context) {
    switch (variable.type) {

      // ── Constante ──────────────────────────────────────────────────────────
      case 'c':
        return variable.params.value?.value;

      // ── Data Layer Variable ────────────────────────────────────────────────
      case 'v': {
        const path = variable.params.name?.value;
        if (!path) return undefined;
        return this._getDataLayerValue(path, context.mergedDataLayer);
      }

      // ── URL Variable ───────────────────────────────────────────────────────
      case 'u': {
        const component = variable.params.component?.value;
        // Peut pointer vers une URL custom (defaultPages, queryKey, etc.)
        const urlSource = variable.params.urlSource?.value;
        const targetUrl = urlSource === 'DEFAULT' || !urlSource
          ? context.pageUrl
          : this.resolveTemplate(urlSource, context);
        return this._resolveUrlComponent(component, targetUrl, variable.params);
      }

      // ── Lookup Table (Tableau de correspondance simple) ────────────────────
      case 'smm': {
        const inputRaw = variable.params.input?.value;
        const input    = this.resolveTemplate(inputRaw, context);

        const mapEntries = variable.params.map?.list || [];
        for (const entry of mapEntries) {
          const entryMap = entry.map || [];
          const find = (k) => entryMap.find(e => e.key === k)?.value;
          const keyResolved = this.resolveTemplate(find('key'), context);
          if (keyResolved === String(input ?? '')) {
            return this.resolveTemplate(find('value'), context);
          }
        }

        // Valeur par défaut
        const defaultBlank = variable.params.defaultBlankIfUnspecified?.value === 'true';
        const defaultVal   = variable.params.defaultValue?.value;
        return defaultBlank ? '' : (defaultVal !== undefined ? this.resolveTemplate(defaultVal, context) : undefined);
      }

      // ── RegEx Table (Tableau de correspondance regex) ──────────────────────
      case 'remm': {
        const inputRaw = variable.params.input?.value;
        const input    = String(this.resolveTemplate(inputRaw, context) ?? '');

        const mapEntries = variable.params.map?.list || [];
        for (const entry of mapEntries) {
          const entryMap = entry.map || [];
          const find = (k) => entryMap.find(e => e.key === k)?.value;

          const pattern    = find('key') ?? '';
          const isRegex    = find('isRegex') !== 'false'; // true par défaut dans remm
          const ignoreCase = find('ignoreCase') === 'true';
          const outValue   = find('value');

          let matches = false;
          if (isRegex) {
            try {
              matches = new RegExp(pattern, ignoreCase ? 'i' : '').test(input);
            } catch { matches = false; }
          } else {
            matches = ignoreCase
              ? input.toLowerCase() === pattern.toLowerCase()
              : input === pattern;
          }

          if (matches) return this.resolveTemplate(outValue, context);
        }

        const defaultVal = variable.params.defaultValue?.value;
        return defaultVal !== undefined ? this.resolveTemplate(defaultVal, context) : undefined;
      }

      // ── JavaScript Variable — nécessite le contexte page ──────────────────
      case 'j': {
        const varPath = variable.params.name?.value;
        if (!varPath) return undefined;
        // GTM évalue le nom comme un chemin dans le scope global
        // On génère le code JS sécurisé pour l'évaluation dans la page
        const safeCode = `(function(){
          try {
            var parts = ${JSON.stringify(varPath.split('.'))};
            var obj = window;
            for (var i = 0; i < parts.length; i++) {
              if (obj == null) return undefined;
              obj = obj[parts[i]];
            }
            return obj;
          } catch(e) { return undefined; }
        })()`;
        return pageEval(safeCode);
      }

      // ── Custom JavaScript — nécessite le contexte page ────────────────────
      case 'jsm': {
        const fnBody = variable.params.javascript?.value;
        if (!fnBody) return undefined;
        // Le corps peut contenir {{VarName}} (syntaxe template GTM).
        // On résout ces références à l'exécution via __gtmPreviewVars
        // (injecté par panel.js avant l'eval) pour éviter d'insérer des
        // valeurs JSON (avec guillemets) à l'intérieur d'une chaîne JSON
        // déjà encodée, ce qui produisait "missing ) after argument list".
        const safeCode = `(function(){
          try {
            var __body = ${JSON.stringify(fnBody)};
            if (typeof __gtmPreviewVars !== 'undefined') {
              __body = __body.replace(/\\{\\{([^}]+)\\}\\}/g, function(m, n) {
                var v = __gtmPreviewVars[n.trim()];
                return v !== undefined && v !== null ? JSON.stringify(v) : 'undefined';
              });
            }
            return (new Function('return (' + __body + ')'))()();
          } catch(e) { return '[Erreur: ' + e.message + ']'; }
        })()`;
        return pageEval(safeCode);
      }

      // ── DOM Element — nécessite le contexte page ───────────────────────────
      case 'd': {
        const selectorType = variable.params.selectorType?.value || 'ID';
        const attributeRaw = variable.params.attributeName?.value;
        // "text" est un alias pour innerText dans GTM
        const attribute    = attributeRaw === 'text' ? 'innerText' : (attributeRaw || 'innerText');

        let selectorExpr;
        if (selectorType === 'ID') {
          const elId = variable.params.elementId?.value || '';
          selectorExpr = `document.getElementById(${JSON.stringify(elId)})`;
        } else {
          const selector = variable.params.elementSelector?.value || '';
          selectorExpr = `document.querySelector(${JSON.stringify(selector)})`;
        }

        const safeCode = `(function(){
          try {
            var el = ${selectorExpr};
            if (!el) return undefined;
            var attr = ${JSON.stringify(attribute)};
            if (attr === 'innerText' || attr === 'textContent') return el[attr];
            var v = el[attr];
            return v !== undefined ? v : el.getAttribute(attr);
          } catch(e) { return '[Erreur DOM: ' + e.message + ']'; }
        })()`;
        return pageEval(safeCode);
      }

      // ── 1st Party Cookie — nécessite le contexte page ─────────────────────
      case 'k': {
        const cookieName = variable.params.name?.value;
        if (!cookieName) return undefined;
        // Lecture sécurisée du cookie (gère les caractères spéciaux dans le nom)
        const safeCode = `(function(n){
          try {
            var escaped = n.replace(/[.*+?^{}()|[\\]\\\\$]/g, '\\\\$&');
            var match = document.cookie.match('(?:^|;\\\\s*)' + escaped + '=([^;]*)');
            return match ? decodeURIComponent(match[1]) : undefined;
          } catch(e) { return undefined; }
        })(${JSON.stringify(cookieName)})`;
        return pageEval(safeCode);
      }

      // ── Auto-Event Variable — depuis mergedDataLayer ───────────────────────
      case 'aev': {
        const varType = variable.params.varType?.value;
        const dlKey   = _aevToDlKey(varType);
        if (dlKey) return context.mergedDataLayer?.[dlKey];
        // Attribut personnalisé de l'élément
        if (varType === 'ATTRIBUTE') {
          const attrName = variable.params.attribute?.value;
          // L'élément est dans gtm.element (objet DOM non sérialisable)
          // On retourne un page eval pour lire l'attribut
          if (attrName) {
            return pageEval(`(function(){
              try {
                var el = window.google_tag_manager && window.dataLayer ?
                  (window.dataLayer.find(function(d){return d['gtm.element'];})||{})['gtm.element']
                  : null;
                return el ? el.getAttribute(${JSON.stringify(attrName)}) : undefined;
              } catch(e){ return undefined; }
            })()`);
          }
        }
        return undefined;
      }

      // ── Referrer (type f) ──────────────────────────────────────────────────
      case 'f': {
        const component = variable.params.component?.value;
        if (!component || component === 'URL') return context.referrer;
        return this._resolveUrlComponent(component, context.referrer, variable.params);
      }

      // ── GA4 Event Settings Variable ────────────────────────────────────────
      case 'gtes': {
        const tableParam = variable.params.eventSettingsTable;
        if (!tableParam?.list) return [];
        return tableParam.list.map(item => {
          const m = item.map || [];
          const findVal = k => m.find(e => e.key === k)?.value;
          return {
            parameter: this.resolveTemplate(findVal('parameter'), context),
            value:     this.resolveTemplate(findVal('value'), context),
          };
        });
      }

      // ── GA4 Configuration Settings Variable ────────────────────────────────
      case 'gtcs': {
        const tableParam = variable.params.configSettingsTable;
        if (!tableParam?.list) return [];
        return tableParam.list.map(item => {
          const m = item.map || [];
          const findVal = k => m.find(e => e.key === k)?.value;
          return {
            parameter: this.resolveTemplate(findVal('parameter'), context),
            value:     this.resolveTemplate(findVal('value'), context),
          };
        });
      }

      // ── Types spéciaux / produits Google non simulés ───────────────────────
      case 'gas':   // Google Analytics Settings (UA legacy)
      case 'awct':  // Google Ads Conversion Tracking
      case 'sp':    // Spécialisation produit
        return `[${variable.type}: non simulable]`;

      default:
        return undefined;
    }
  }

  // ─── Helpers privés ───────────────────────────────────────────────────────

  /**
   * Traverse le dataLayer fusionné selon un chemin pointé.
   * @param {string} path  - ex: "ecommerce.transaction_id"
   * @param {Object} dl
   * @returns {*}
   */
  _getDataLayerValue(path, dl) {
    if (!path || !dl) return undefined;
    let cur = dl;
    for (const part of path.split('.')) {
      if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
      cur = cur[part];
    }
    return cur;
  }

  /**
   * Extrait un composant d'une URL.
   * @param {string} component  - Composant GTM (HOST, PATH, QUERY, etc.)
   * @param {string} url
   * @param {Object} params     - Paramètres de la variable (pour QUERY_KEY, etc.)
   * @returns {string|undefined}
   */
  _resolveUrlComponent(component, url, params = {}) {
    if (!url) return undefined;
    try {
      const p = new URL(url);
      switch (component) {
        case 'PROTOCOL':    return p.protocol.replace(':', '');
        case 'HOST':        return p.hostname;
        case 'PORT':        return p.port || undefined;
        case 'PATH':        return p.pathname;
        case 'QUERY':       return p.search.replace(/^\?/, '');
        case 'FRAGMENT':    return p.hash.replace(/^#/, '');
        case 'URL':         return url;
        case 'QUERY_KEY': {
          const key = params.queryKey?.value;
          return key ? (p.searchParams.get(key) ?? undefined) : undefined;
        }
        default: return url;
      }
    } catch {
      return url;
    }
  }
}

// ─── Mapping Auto-Event Variable type → clé dataLayer GTM ────────────────────

function _aevToDlKey(varType) {
  const map = {
    'ELEMENT':         'gtm.element',
    'ELEMENT_ID':      'gtm.elementId',
    'ELEMENT_CLASSES': 'gtm.elementClasses',
    'ELEMENT_TARGET':  'gtm.elementTarget',
    'ELEMENT_URL':     'gtm.elementUrl',
    'ELEMENT_TEXT':    'gtm.elementText',
    'HISTORY_SOURCE':  'gtm.historyChangeSource',
  };
  return map[varType];
}
