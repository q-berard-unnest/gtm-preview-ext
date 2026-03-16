// ============================================================
// devtools.js — Création du panel dans Chrome DevTools
// ============================================================
// S'exécute dans le contexte DevTools (accès à chrome.devtools.*)
// Crée un onglet "GTM Preview" dans les DevTools.
// ============================================================

'use strict';

chrome.devtools.panels.create(
  'GTM Preview',          // Titre de l'onglet dans DevTools
  null,                   // Chemin vers l'icône (null = icône par défaut)
  'devtools/panel.html',  // Page HTML du panel
  (panel) => {
    // Callback appelé quand le panel est créé (peut être utilisé pour des événements panel)
    if (chrome.runtime.lastError) {
      console.error('[GTM Preview] Erreur création panel:', chrome.runtime.lastError.message);
      return;
    }
    // panel.onShown / panel.onHidden disponibles si besoin dans les phases suivantes
  }
);
