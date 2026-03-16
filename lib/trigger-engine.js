// ============================================================
// lib/trigger-engine.js — Moteur d'évaluation des triggers GTM
// ============================================================
// Évalue les triggers d'un conteneur GTM contre un événement
// dataLayer et son contexte page.
//
// Phase 5 : types de triggers supportés
//   • PAGEVIEW          → "gtm.js"
//   • DOM_READY         → "gtm.dom"
//   • WINDOW_LOADED     → "gtm.load"
//   • CUSTOM_EVENT      → tout autre événement custom
//   • CLICK             → "gtm.click"
//   • LINK_CLICK        → "gtm.linkClick"
//   • FORM_SUBMIT       → "gtm.formSubmit"
//   • HISTORY_CHANGE    → "gtm.historyChange"
//   • SCROLL_DEPTH      → "gtm.scrollDepth" (avec vérif. de seuil)
//   • ELEMENT_VISIBILITY→ "gtm.elementVisibility"
//   • INIT              → "gtm.init" / "gtm.init_consent"
//   • JS_ERROR          → "gtm.pageError"
//   • TIMER             → "gtm.timer"
//   • YOUTUBE_VIDEO     → "gtm.video"
//
// Opérateurs de condition supportés :
//   EQUALS, CONTAINS, STARTS_WITH, ENDS_WITH, MATCH_REGEX,
//   DOES_NOT_EQUAL, DOES_NOT_CONTAIN, GREATER_THAN, LESS_THAN,
//   GREATER_THAN_OR_EQUALS, LESS_THAN_OR_EQUALS, CSS_SELECTOR*
//   (* non supporté côté service-worker, marqué non-supporté)
// ============================================================

'use strict';

import { VariableResolver } from './variable-resolver.js';

// ─── Constantes ───────────────────────────────────────────────────────────────

/** Événements GTM synthétiques qui ne sont PAS des CUSTOM_EVENT */
const GTM_SYNTHETIC_EVENTS = new Set(['gtm.js', 'gtm.dom', 'gtm.load',
  'gtm.historyChange', 'gtm.click', 'gtm.linkClick', 'gtm.formSubmit',
  'gtm.timer', 'gtm.scrollDepth', 'gtm.elementVisibility']);

/** Types de triggers supportés en Phase 5 */
const SUPPORTED_TRIGGER_TYPES = new Set([
  'PAGEVIEW', 'DOM_READY', 'WINDOW_LOADED', 'CUSTOM_EVENT',
  'CLICK', 'LINK_CLICK', 'FORM_SUBMIT', 'HISTORY_CHANGE',
  'SCROLL_DEPTH', 'ELEMENT_VISIBILITY',
  'INIT', 'JS_ERROR', 'TIMER', 'YOUTUBE_VIDEO',
]);

// ─── Helpers de lecture des paramètres ───────────────────────────────────────

/**
 * Extrait la valeur d'un paramètre GTM dans un tableau de paramètres.
 * @param {Array}  params - tableau de { type, key, value, ... }
 * @param {string} key    - clé recherchée (arg0, arg1, negate, etc.)
 * @returns {string|undefined}
 */
function getParam(params, key) {
  if (!Array.isArray(params)) return undefined;
  const p = params.find(p => p.key === key);
  return p?.value;
}

// ─── Classe principale ───────────────────────────────────────────────────────

export class TriggerEngine {
  /**
   * @param {ParsedContainer} parsedContainer
   */
  constructor(parsedContainer) {
    this.container            = parsedContainer;   // référence complète (Phase 3)
    this.triggers             = parsedContainer.triggers;
    this.firingTagsByTriggerId = parsedContainer.firingTagsByTriggerId;
    this.resolver             = new VariableResolver(parsedContainer);
  }

  // ─── Résolution de toutes les variables (Phase 3) ───────────────────────────

  /**
   * Résout toutes les variables du conteneur (built-ins + utilisateur)
   * dans le contexte d'un événement donné.
   * Les variables client-side (jsm, j, d, k) retournent un marqueur PAGE_EVAL.
   *
   * @param {Object} payload          - Push dataLayer courant
   * @param {Object} pageContext       - Contexte page (URL, referrer, etc.)
   * @param {Object} mergedDataLayer   - État fusionné du dataLayer
   * @returns {Object}  Map { variableName: resolvedValue }
   */
  resolveAllVariables(payload, pageContext, mergedDataLayer) {
    const context = this._buildContext(payload, pageContext, mergedDataLayer);
    const result  = {};

    // Variables built-in déclarées dans le conteneur
    // On n'itère que les clés de type (majuscules) pour éviter les doublons nom/type
    for (const [key, bv] of this.container.builtInVariables) {
      if (/^[A-Z_]+$/.test(key) && bv.name && !(bv.name in result)) {
        const val = this.resolver._resolveBuiltInByType(bv.type, context);
        if (val !== undefined) result[bv.name] = val;
      }
    }

    // Variables utilisateur
    for (const [, variable] of this.container.variablesByName) {
      result[variable.name] = this.resolver._resolveUserVariable(variable, context);
    }

    return result;
  }

  /**
   * Construit le contexte de résolution des variables.
   * @private
   */
  _buildContext(payload, pageContext, mergedDataLayer) {
    return {
      eventName:       payload?.event           || '',
      pageUrl:         pageContext?.pageUrl      || '',
      pageHostname:    pageContext?.pageHostname || '',
      pagePath:        pageContext?.pagePath     || '',
      pageQuery:       pageContext?.pageQuery    || '',
      pageFragment:    pageContext?.pageFragment || '',
      referrer:        pageContext?.referrer     || '',
      mergedDataLayer: mergedDataLayer           || {},
      payload:         payload                  || {},
    };
  }

  // ─── Évaluation de tous les triggers ────────────────────────────────────────

  /**
   * Évalue tous les triggers du conteneur contre un événement dataLayer.
   *
   * @param {Object} payload          - L'objet pushé dans le dataLayer (ex: { event: 'purchase', ... })
   * @param {Object} pageContext       - Contexte page capturé par injected.js
   * @param {Object} mergedDataLayer   - État fusionné du dataLayer à ce moment
   * @returns {TriggerResult[]}        - Tableau de résultats pour chaque trigger
   */
  evaluateAll(payload, pageContext, mergedDataLayer) {
    const context = this._buildContext(payload, pageContext, mergedDataLayer);

    const results = [];
    for (const [, trigger] of this.triggers) {
      results.push(this._evaluateTrigger(trigger, context));
    }
    return results;
  }

  // ─── Évaluation d'un trigger ────────────────────────────────────────────────

  /**
   * Évalue un trigger unique.
   * @param {NormalizedTrigger} trigger
   * @param {Object}            context
   * @returns {TriggerResult}
   *
   * TriggerResult :
   * {
   *   triggerId,       // string
   *   triggerName,     // string
   *   triggerType,     // string
   *   matched,         // boolean
   *   reason,          // 'matched' | 'type_mismatch' | 'custom_event_filter' |
   *                    //  'filter_failed' | 'unsupported_type'
   *   reasonLabel,     // string — description lisible
   *   failedCondition, // { arg0Raw, arg0Resolved, arg1Raw, arg1Resolved, operator, conditionIndex }
   *   firingTags,      // [{ tagId, tagName }] — tags qui se déclencheraient
   * }
   */
  _evaluateTrigger(trigger, context) {
    const base = {
      triggerId:       trigger.triggerId,
      triggerName:     trigger.name,
      triggerType:     trigger.type,
      matched:         false,
      reason:          '',
      reasonLabel:     '',
      failedCondition: null,
      firingTags:      this._getFireingTags(trigger.triggerId),
    };

    // ── 1. Type non supporté ─────────────────────────────────────────────────
    if (!SUPPORTED_TRIGGER_TYPES.has(trigger.type)) {
      return {
        ...base,
        reason:      'unsupported_type',
        reasonLabel: `Type ${trigger.type} — non supporté`,
      };
    }

    // ── 2. L'événement actuel active-t-il ce type de trigger ? ───────────────
    if (!this._eventActivatesTriggerType(context.eventName, trigger.type)) {
      const expected = this._expectedEventForType(trigger.type);
      return {
        ...base,
        reason:      'type_mismatch',
        reasonLabel: `Requiert "${expected}" — reçu "${context.eventName || '(vide)'}"`,
      };
    }

    // ── 2b. SCROLL_DEPTH : vérifier les seuils configurés ────────────────────
    if (trigger.type === 'SCROLL_DEPTH') {
      const scrollCheckResult = this._checkScrollDepthThreshold(trigger, context);
      if (scrollCheckResult) return { ...base, ...scrollCheckResult };
    }

    // ── 3. CUSTOM_EVENT : vérifier customEventFilter (filtre sur le nom) ─────
    if (trigger.type === 'CUSTOM_EVENT' && trigger.customEventFilter.length > 0) {
      for (let i = 0; i < trigger.customEventFilter.length; i++) {
        const condResult = this._evaluateCondition(trigger.customEventFilter[i], context);
        if (!condResult.passed) {
          return {
            ...base,
            reason:          'custom_event_filter',
            reasonLabel:     `Filtre événement non satisfait : ${condResult.description}`,
            failedCondition: { ...condResult, conditionIndex: i, source: 'customEventFilter' },
          };
        }
      }
    }

    // ── 4. Vérifier les filtres additionnels ──────────────────────────────────
    for (let i = 0; i < trigger.filter.length; i++) {
      const condResult = this._evaluateCondition(trigger.filter[i], context);
      if (!condResult.passed) {
        return {
          ...base,
          reason:          'filter_failed',
          reasonLabel:     `Filtre ${i + 1} non satisfait : ${condResult.description}`,
          failedCondition: { ...condResult, conditionIndex: i, source: 'filter' },
        };
      }
    }

    // ── 5. Toutes les conditions passent → trigger matché ─────────────────────
    return {
      ...base,
      matched:     true,
      reason:      'matched',
      reasonLabel: 'Déclenché',
    };
  }

  // ─── Évaluation d'une condition ──────────────────────────────────────────────

  /**
   * Évalue une condition GTM (un élément de filter[] ou customEventFilter[]).
   *
   * @param {Object} condition  - { type, parameter: [...] }
   * @param {Object} context
   * @returns {{ passed, description, arg0Raw, arg0Resolved, arg1Raw, arg1Resolved, operator, negated }}
   */
  _evaluateCondition(condition, context) {
    const arg0Raw = getParam(condition.parameter, 'arg0') ?? '';
    const arg1Raw = getParam(condition.parameter, 'arg1') ?? '';

    // Résoudre les variables dans les opérandes
    const arg0 = this.resolver.resolveTemplate(arg0Raw, context);
    const arg1 = this.resolver.resolveTemplate(arg1Raw, context);

    // Lire le flag negate (format ancien : paramètre "negate" avec valeur "true")
    const negateParam = getParam(condition.parameter, 'negate');
    const negated     = negateParam === 'true';

    // Appliquer l'opérateur
    let rawPassed;
    let operatorLabel;

    const s0 = arg0 !== null && arg0 !== undefined ? String(arg0) : '';
    const s1 = arg1 !== null && arg1 !== undefined ? String(arg1) : '';

    switch (condition.type) {
      case 'EQUALS':
        rawPassed     = s0 === s1;
        operatorLabel = '=';
        break;
      case 'DOES_NOT_EQUAL':
        rawPassed     = s0 !== s1;
        operatorLabel = '≠';
        break;
      case 'CONTAINS':
        rawPassed     = s0.includes(s1);
        operatorLabel = 'contient';
        break;
      case 'DOES_NOT_CONTAIN':
        rawPassed     = !s0.includes(s1);
        operatorLabel = 'ne contient pas';
        break;
      case 'STARTS_WITH':
        rawPassed     = s0.startsWith(s1);
        operatorLabel = 'commence par';
        break;
      case 'ENDS_WITH':
        rawPassed     = s0.endsWith(s1);
        operatorLabel = 'finit par';
        break;
      case 'MATCH_REGEX':
      case 'MATCH_REGEX_IGNORE_CASE': {
        const flags   = condition.type === 'MATCH_REGEX_IGNORE_CASE' ? 'i' : '';
        operatorLabel = 'regex';
        try {
          rawPassed = new RegExp(s1, flags).test(s0);
        } catch {
          rawPassed     = false;
          operatorLabel = 'regex (invalide)';
        }
        break;
      }
      case 'GREATER_THAN':
        rawPassed     = parseFloat(s0) > parseFloat(s1);
        operatorLabel = '>';
        break;
      case 'LESS_THAN':
        rawPassed     = parseFloat(s0) < parseFloat(s1);
        operatorLabel = '<';
        break;
      case 'GREATER_THAN_OR_EQUALS':
        rawPassed     = parseFloat(s0) >= parseFloat(s1);
        operatorLabel = '≥';
        break;
      case 'LESS_THAN_OR_EQUALS':
        rawPassed     = parseFloat(s0) <= parseFloat(s1);
        operatorLabel = '≤';
        break;
      case 'CSS_SELECTOR':
        // Nécessite le DOM de la page — non accessible depuis le service worker
        rawPassed     = false;
        operatorLabel = 'css selector (non supporté ici)';
        break;
      default:
        rawPassed     = false;
        operatorLabel = `opérateur inconnu (${condition.type})`;
    }

    // Appliquer negate
    const passed = negated ? !rawPassed : rawPassed;

    // Description lisible (pour affichage dans le panel)
    const arg0Display = arg0Raw !== arg0 ? `${arg0Raw} → "${s0}"` : `"${s0}"`;
    const arg1Display = `"${s1}"`;
    const description = `${arg0Display} ${operatorLabel} ${arg1Display}`;

    return {
      passed,
      description,
      arg0Raw,
      arg0Resolved: s0,
      arg1Raw,
      arg1Resolved: s1,
      operator:     operatorLabel,
      negated,
      operatorType: condition.type,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Détermine si un nom d'événement dataLayer active un type de trigger donné.
   * @param {string} eventName
   * @param {string} triggerType
   * @returns {boolean}
   */
  _eventActivatesTriggerType(eventName, triggerType) {
    switch (triggerType) {
      case 'PAGEVIEW':            return eventName === 'gtm.js';
      case 'DOM_READY':           return eventName === 'gtm.dom';
      case 'WINDOW_LOADED':       return eventName === 'gtm.load';
      case 'CLICK':               return eventName === 'gtm.click';
      case 'LINK_CLICK':          return eventName === 'gtm.linkClick';
      case 'FORM_SUBMIT':         return eventName === 'gtm.formSubmit';
      case 'HISTORY_CHANGE':      return eventName === 'gtm.historyChange';
      case 'SCROLL_DEPTH':        return eventName === 'gtm.scrollDepth';
      case 'ELEMENT_VISIBILITY':  return eventName === 'gtm.elementVisibility';
      case 'INIT':                return eventName === 'gtm.init' || eventName === 'gtm.init_consent';
      case 'JS_ERROR':            return eventName === 'gtm.pageError';
      case 'TIMER':               return eventName === 'gtm.timer';
      case 'YOUTUBE_VIDEO':       return eventName === 'gtm.video';
      case 'CUSTOM_EVENT':
        // Tout événement qui n'est pas un événement GTM synthétique réservé
        return !GTM_SYNTHETIC_EVENTS.has(eventName);
      default:
        return false;
    }
  }

  /**
   * Retourne le nom d'événement dataLayer attendu pour un type de trigger.
   * @param {string} triggerType
   * @returns {string}
   */
  _expectedEventForType(triggerType) {
    const map = {
      'PAGEVIEW':           'gtm.js',
      'DOM_READY':          'gtm.dom',
      'WINDOW_LOADED':      'gtm.load',
      'CLICK':              'gtm.click',
      'LINK_CLICK':         'gtm.linkClick',
      'FORM_SUBMIT':        'gtm.formSubmit',
      'HISTORY_CHANGE':     'gtm.historyChange',
      'SCROLL_DEPTH':       'gtm.scrollDepth',
      'ELEMENT_VISIBILITY': 'gtm.elementVisibility',
      'INIT':               'gtm.init / gtm.init_consent',
      'JS_ERROR':           'gtm.pageError',
      'TIMER':              'gtm.timer',
      'YOUTUBE_VIDEO':      'gtm.video',
      'CUSTOM_EVENT':       '(événement custom)',
    };
    return map[triggerType] || triggerType;
  }

  /**
   * Pour les triggers SCROLL_DEPTH, vérifie que le seuil de l'événement
   * correspond à l'un des seuils configurés sur le trigger.
   * Retourne un objet d'override de statut si le seuil ne correspond pas,
   * ou null si la vérification passe (ou si aucun seuil n'est configuré).
   * @param {NormalizedTrigger} trigger
   * @param {Object}            context
   * @returns {Object|null}
   */
  _checkScrollDepthThreshold(trigger, context) {
    // Seuils configurés dans les paramètres du trigger
    const thresholdParam = trigger.params?.verticalThresholds || trigger.params?.horizontalThresholds;
    if (!thresholdParam?.list?.length) return null; // Pas de seuil configuré → laisser passer

    const configuredThresholds = thresholdParam.list
      .map(item => Number(item.value))
      .filter(n => !isNaN(n));

    if (configuredThresholds.length === 0) return null;

    // Seuil de l'événement courant
    const eventThreshold = Number(context.payload?.['gtm.scrollThreshold']);
    if (isNaN(eventThreshold)) return null;

    if (!configuredThresholds.includes(eventThreshold)) {
      return {
        reason:      'filter_failed',
        reasonLabel: `Seuil ${eventThreshold}% non configuré (seuils : ${configuredThresholds.join(', ')}%)`,
      };
    }

    // Vérifier les unités (si configurées)
    const unitsParam   = trigger.params?.verticalThresholdUnits;
    const configuredUnit = unitsParam?.value?.toUpperCase() || 'PERCENT';
    const eventUnit      = (context.payload?.['gtm.scrollUnits'] || 'percent').toUpperCase();
    if (configuredUnit !== eventUnit) {
      return {
        reason:      'filter_failed',
        reasonLabel: `Unité "${eventUnit}" ≠ "${configuredUnit}" configuré`,
      };
    }

    return null;
  }

  /**
   * Retourne les tags qui se déclencheraient si ce trigger était activé.
   * @param {string} triggerId
   * @returns {Array<{ tagId, tagName }>}
   */
  _getFireingTags(triggerId) {
    const tags = this.firingTagsByTriggerId.get(triggerId) || [];
    return tags.map(t => ({ tagId: t.tagId, tagName: t.name }));
  }
}
