// ============================================================
// lib/tag-engine.js — Moteur d'évaluation des tags GTM
// ============================================================
// Détermine pour chaque événement quels tags se déclenchent,
// lesquels sont bloqués, et lesquels ne font rien.
//
// Règles appliquées (dans l'ordre) :
//   1. Tag en pause → NOT_FIRED
//   2. Un trigger bloquant a matché → BLOCKED  (prioritaire)
//   3. Aucun trigger déclencheur n'a matché → NOT_FIRED
//   4. tagFiringOption ONCE + déjà déclenché → NOT_FIRED
//   5. Tag sequencing : setupTag avec stopOnSetupFailure → NOT_FIRED
//   6. Sinon → FIRED
//
// tagFiringOption :
//   ONCE          → au plus une fois par page (comptabilisé dans firedCounts)
//   ONCE_PER_EVENT → une fois par push dataLayer (évaluation indépendante)
//   UNLIMITED     → sans limite
// ============================================================

'use strict';

// ─── Noms lisibles des types de tags GTM ──────────────────────────────────────

const TAG_TYPE_LABELS = {
  'html':  'Custom HTML',
  'gaawc': 'GA4 Config',
  'gaawe': 'GA4 Event',
  'ua':    'Universal Analytics',
  'awct':  'Google Ads Conversion',
  'sp':    'Conversion Linker',
  'flc':   'Floodlight Counter',
  'fls':   'Floodlight Sales',
  'img':   'Custom Image',
  'gclidw':'Click ID Cookie',
  'bzi':   'Bizible',
  'adm':   'Adometry',
};

export function getTagTypeLabel(type) {
  return TAG_TYPE_LABELS[type] || type || '?';
}

// ─── Classe principale ───────────────────────────────────────────────────────

export class TagEngine {
  /**
   * @param {ParsedContainer} parsedContainer
   */
  constructor(parsedContainer) {
    this.tags     = parsedContainer.tags;
    this.triggers = parsedContainer.triggers;
  }

  // ─── Évaluation principale ───────────────────────────────────────────────

  /**
   * Évalue tous les tags du conteneur pour un événement donné.
   *
   * @param {TriggerResult[]} triggerResults      - Résultats des triggers (Phase 2)
   * @param {Map<string,number>} firedCounts      - tagId → nb de fires depuis le chargement de page
   *                                                (utilisé pour l'option ONCE uniquement)
   * @returns {{ results: TagResult[], toIncrement: string[] }}
   *   results:      tableau de TagResult pour chaque tag
   *   toIncrement:  tagIds des tags FIRED avec option ONCE (à comptabiliser dans firedCounts)
   */
  evaluate(triggerResults, firedCounts) {
    // Ensemble des triggerId qui ont matché pour cet événement
    const matchedTriggerIds = new Set(
      (triggerResults || []).filter(r => r.matched).map(r => r.triggerId)
    );

    // Trier par priorité décroissante (les tags à priorité haute s'exécutent en premier)
    const sortedTags = [...this.tags.values()].sort(
      (a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0)
    );

    // Première passe : évaluation individuelle de chaque tag
    const results = sortedTags.map(tag =>
      this._evalTag(tag, matchedTriggerIds, firedCounts)
    );

    // Deuxième passe : tag sequencing (setupTag avec stopOnSetupFailure)
    this._applySequencing(results);

    // Identifier les tags FIRED avec option ONCE → à comptabiliser
    const toIncrement = results
      .filter(r => r.status === 'FIRED' && r.firingOption === 'ONCE')
      .map(r => r.tagId);

    return { results, toIncrement };
  }

  // ─── Évaluation d'un tag ─────────────────────────────────────────────────

  /**
   * @param {NormalizedTag} tag
   * @param {Set<string>}   matchedTriggerIds
   * @param {Map<string,number>} firedCounts
   * @returns {TagResult}
   *
   * TagResult :
   * {
   *   tagId, tagName, tagType, tagTypeLabel,
   *   firingOption,   // 'ONCE' | 'ONCE_PER_EVENT' | 'UNLIMITED'
   *   priority,
   *   status,         // 'FIRED' | 'BLOCKED' | 'NOT_FIRED'
   *   reason,         // description lisible
   *   firedByTriggerId, firedByTriggerName,
   *   blockedByTriggerId, blockedByTriggerName,
   *   fireCount,      // nb de fires ONCE pour ce tag (contexte page entière)
   *   setupTag,       // tableau raw du sequencing
   *   teardownTag,
   *   sequencingBlocked, // true si bloqué par setup tag
   * }
   */
  _evalTag(tag, matchedTriggerIds, firedCounts) {
    const firingOption = this._normalizeOption(tag.firingOption);
    const fireCount    = firedCounts.get(tag.tagId) || 0;

    const base = {
      tagId:                tag.tagId,
      tagName:              tag.name,
      tagType:              tag.type,
      tagTypeLabel:         getTagTypeLabel(tag.type),
      firingOption,
      priority:             Number(tag.priority) || 0,
      status:               'NOT_FIRED',
      reason:               '',
      firedByTriggerId:     null,
      firedByTriggerName:   null,
      blockedByTriggerId:   null,
      blockedByTriggerName: null,
      fireCount,
      setupTag:             tag.setupTag    || [],
      teardownTag:          tag.teardownTag || [],
      sequencingBlocked:    false,
    };

    // ── Tag en pause ────────────────────────────────────────────────────────
    if (tag.paused) {
      return { ...base, reason: 'Tag mis en pause dans GTM' };
    }

    // ── 1. Triggers bloquants (PRIORITAIRES sur les triggers déclencheurs) ──
    for (const blockingId of tag.blockingTriggerId) {
      if (matchedTriggerIds.has(blockingId)) {
        const bt = this.triggers.get(blockingId);
        return {
          ...base,
          status:               'BLOCKED',
          reason:               `Bloqué par le trigger "${bt?.name || blockingId}"`,
          blockedByTriggerId:   blockingId,
          blockedByTriggerName: bt?.name || blockingId,
        };
      }
    }

    // ── 2. Triggers déclencheurs ─────────────────────────────────────────────
    let firedByTriggerId = null;
    for (const firingId of tag.firingTriggerId) {
      if (matchedTriggerIds.has(firingId)) {
        firedByTriggerId = firingId;
        break; // Premier trigger matché (selon la priorité du tag)
      }
    }

    if (!firedByTriggerId) {
      return { ...base, reason: 'Aucun trigger de déclenchement actif pour cet événement' };
    }

    const ft = this.triggers.get(firedByTriggerId);
    const firedByTriggerName = ft?.name || firedByTriggerId;

    // ── 3. tagFiringOption ONCE : vérifier si déjà déclenché ────────────────
    if (firingOption === 'ONCE' && fireCount > 0) {
      return {
        ...base,
        status:             'NOT_FIRED',
        reason:             `Non déclenché : option ONCE — déjà déclenché ${fireCount}x sur cette page`,
        firedByTriggerId,
        firedByTriggerName,
      };
    }

    // ── Le tag se déclenche ──────────────────────────────────────────────────
    return {
      ...base,
      status:             'FIRED',
      reason:             `Déclenché par "${firedByTriggerName}"`,
      firedByTriggerId,
      firedByTriggerName,
    };
  }

  // ─── Tag sequencing ──────────────────────────────────────────────────────

  /**
   * Deuxième passe : applique les règles de setupTag.
   * Si un setupTag avec stopOnSetupFailure=true n'est PAS FIRED,
   * le tag principal passe à NOT_FIRED.
   *
   * @param {TagResult[]} results - Modifié en place
   */
  _applySequencing(results) {
    // Index par nom de tag (setupTag référence les tags par name, pas par ID)
    const byName = new Map(results.map(r => [r.tagName, r]));

    for (const result of results) {
      if (!result.setupTag.length) continue;
      if (result.status !== 'FIRED') continue; // Déjà bloqué/not-fired

      for (const setupRef of result.setupTag) {
        const setupName       = setupRef.tagName || setupRef.name;
        const stopOnFailure   = setupRef.stopOnSetupFailure === true
                             || setupRef.stopOnSetupFailure === 'true';
        if (!stopOnFailure) continue;

        const setupResult = byName.get(setupName);
        if (setupResult && setupResult.status !== 'FIRED') {
          result.status           = 'NOT_FIRED';
          result.reason           = `Setup tag "${setupName}" non déclenché (stopOnSetupFailure=true)`;
          result.sequencingBlocked = true;
          break;
        }
      }
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Normalise les variantes de la valeur tagFiringOption.
   * GTM utilise parfois des casses différentes selon les versions d'export.
   */
  _normalizeOption(raw) {
    if (!raw) return 'ONCE_PER_EVENT';
    const s = String(raw).toUpperCase().replace(/-/g, '_');
    if (s === 'ONCE')           return 'ONCE';
    if (s === 'UNLIMITED')      return 'UNLIMITED';
    return 'ONCE_PER_EVENT'; // valeur par défaut GTM
  }
}
