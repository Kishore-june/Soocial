'use strict';

// Ne pas deranger : calcul des echeances, sans Electron. Sorti de main.js pour
// la meme raison que audio.js — la logique de dates se teste sans lancer
// l'application entiere.

// L'etat stocke tient en deux champs : `until` (0 = inactif, -1 = jusqu'a
// desactivation manuelle, sinon un timestamp ms) et `choice`, le libelle coche
// dans les menus — le timestamp seul ne dit pas si l'utilisateur a choisi
// "30 minutes" ou "1 heure".

const CHOICES = ['off', '30', '60', 'morning', 'on'];

const MORNING_HOUR = 8; // "jusqu'a demain matin" = prochain 8 h local

/**
 * Echeance pour un choix donne. `now` en ms. Retourne 0 (inactif), -1
 * (indefini) ou un timestamp ms strictement futur.
 */
function computeUntil(choice, now) {
  switch (choice) {
    case '30':
      return now + 30 * 60 * 1000;
    case '60':
      return now + 60 * 60 * 1000;
    case 'morning': {
      // Prochain 8 h local : a 7 h du matin, "demain matin" tombe dans une
      // heure — c'est le matin qu'on vise, pas un delai de 24 h.
      const date = new Date(now);
      date.setHours(MORNING_HOUR, 0, 0, 0);
      if (date.getTime() <= now) date.setDate(date.getDate() + 1);
      return date.getTime();
    }
    case 'on':
      return -1;
    default:
      return 0;
  }
}

/** Le mode est-il actif a l'instant `now` ? Une echeance passee vaut inactif. */
function isActive(until, now) {
  return until === -1 || until > now;
}

module.exports = { CHOICES, MORNING_HOUR, computeUntil, isActive };
