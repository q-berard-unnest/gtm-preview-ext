// ============================================================
// lib/gtm-parser.js — Parseur du JSON d'export GTM
// ============================================================
// Transforme le JSON brut exporté depuis GTM en une structure
// interne exploitable : maps indexées par ID, relations inversées,
// paramètres normalisés en objets clé-valeur.
// ============================================================

'use strict';

// ─── Helpers internes ─────────────────────────────────────────────────────────

/**
 * Convertit le tableau de paramètres GTM en objet clé→valeur.
 * Format source : [{ type, key, value, list, map }, ...]
 * @param {Array}  params
 * @returns {Object}  { key: { type, value, list, map } }
 */
function paramsToMap(params) {
  const result = {};
  if (!Array.isArray(params)) return result;
  for (const p of params) {
    if (p.key !== undefined) {
      result[p.key] = {
        type:  p.type,
        value: p.value,
        list:  p.list,
        map:   p.map,
      };
    }
  }
  return result;
}

/**
 * Normalise un objet tag GTM.
 * @param {Object} raw
 * @returns {NormalizedTag}
 */
function normalizeTag(raw) {
  return {
    tagId:             raw.tagId,
    name:              raw.name              || '(sans nom)',
    type:              raw.type              || '',
    params:            paramsToMap(raw.parameter),
    firingTriggerId:   raw.firingTriggerId   || [],
    blockingTriggerId: raw.blockingTriggerId || [],
    firingOption:      raw.tagFiringOption   || 'ONCE_PER_EVENT',
    priority:          parseInt(raw.priority?.value ?? raw.priority ?? 0, 10),
    setupTag:          raw.setupTag          || [],
    teardownTag:       raw.teardownTag       || [],
    paused:            raw.paused            === true,
    raw,
  };
}

/**
 * Normalise un objet trigger GTM.
 * @param {Object} raw
 * @returns {NormalizedTrigger}
 */
function normalizeTrigger(raw) {
  return {
    triggerId:         raw.triggerId,
    name:              raw.name              || '(sans nom)',
    type:              raw.type              || '',
    customEventFilter: raw.customEventFilter || [],
    filter:            raw.filter            || [],
    params:            paramsToMap(raw.parameter),
    raw,
  };
}

/**
 * Normalise un objet variable GTM.
 * @param {Object} raw
 * @returns {NormalizedVariable}
 */
function normalizeVariable(raw) {
  return {
    variableId: raw.variableId,
    name:       raw.name || '(sans nom)',
    type:       raw.type || '',
    params:     paramsToMap(raw.parameter),
    raw,
  };
}

// ─── Fonction principale ──────────────────────────────────────────────────────

/**
 * Parse un JSON d'export GTM en structure interne exploitable.
 *
 * @param {Object} rawJson  - Le JSON brut tel qu'importé par l'utilisateur
 * @returns {ParsedContainer}
 * @throws {Error} Si la structure JSON est invalide
 *
 * Structure retournée :
 * {
 *   raw,             // JSON brut original
 *   meta,            // { containerId, publicId, containerName, version, exportTime }
 *   tags,            // Map<tagId, NormalizedTag>
 *   triggers,        // Map<triggerId, NormalizedTrigger>
 *   variables,       // Map<variableId, NormalizedVariable>
 *   variablesByName, // Map<name, NormalizedVariable>    — pour résolution {{Name}}
 *   builtInVariables,// Map<type|name, BuiltInVariable>  — variables natives GTM
 *   firingTagsByTriggerId,   // Map<triggerId, NormalizedTag[]>
 *   blockingTagsByTriggerId, // Map<triggerId, NormalizedTag[]>
 * }
 */
export function parseContainer(rawJson) {
  if (!rawJson || typeof rawJson !== 'object') {
    throw new Error('Le JSON fourni est null ou non-objet.');
  }

  const cv = rawJson.containerVersion;
  if (!cv) {
    throw new Error('Structure JSON invalide : clé "containerVersion" manquante. Vérifiez que c\'est bien un export GTM.');
  }

  // ── Métadonnées ─────────────────────────────────────────────────────────────
  const meta = {
    containerId:   cv.containerId              || '',
    publicId:      cv.container?.publicId      || '',
    containerName: cv.container?.name          || cv.name || 'Inconnu',
    version:       cv.containerVersionId       || '0',
    exportTime:    rawJson.exportTime          || '',
    formatVersion: rawJson.exportFormatVersion ?? 2,
  };

  // ── Tags ─────────────────────────────────────────────────────────────────────
  const tags = new Map();
  for (const tag of (cv.tag || [])) {
    tags.set(tag.tagId, normalizeTag(tag));
  }

  // ── Triggers ─────────────────────────────────────────────────────────────────
  const triggers = new Map();
  for (const trig of (cv.trigger || [])) {
    triggers.set(trig.triggerId, normalizeTrigger(trig));
  }

  // ── Variables utilisateur ────────────────────────────────────────────────────
  const variables      = new Map();   // par variableId
  const variablesByName = new Map();  // par name (pour {{Name}} resolution)
  for (const v of (cv.variable || [])) {
    const norm = normalizeVariable(v);
    variables.set(v.variableId, norm);
    variablesByName.set(v.name, norm);
  }

  // ── Variables built-in ───────────────────────────────────────────────────────
  // Indexées à la fois par type (PAGE_URL) et par nom (Page URL)
  const builtInVariables = new Map();
  for (const bv of (cv.builtInVariable || [])) {
    builtInVariables.set(bv.type, bv);
    if (bv.name) builtInVariables.set(bv.name, bv);
  }

  // ── Relations inverses : triggerId → [tags] ──────────────────────────────────
  const firingTagsByTriggerId   = new Map();
  const blockingTagsByTriggerId = new Map();

  for (const tag of tags.values()) {
    for (const tid of tag.firingTriggerId) {
      if (!firingTagsByTriggerId.has(tid)) firingTagsByTriggerId.set(tid, []);
      firingTagsByTriggerId.get(tid).push(tag);
    }
    for (const tid of tag.blockingTriggerId) {
      if (!blockingTagsByTriggerId.has(tid)) blockingTagsByTriggerId.set(tid, []);
      blockingTagsByTriggerId.get(tid).push(tag);
    }
  }

  return {
    raw: rawJson,
    meta,
    tags,
    triggers,
    variables,
    variablesByName,
    builtInVariables,
    firingTagsByTriggerId,
    blockingTagsByTriggerId,
  };
}
