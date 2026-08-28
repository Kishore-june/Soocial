'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

/**
 * Traductions.
 *
 * Le process principal est seul a lire les fichiers de langue : le renderer,
 * sandboxe, recoit le dictionnaire resolu au demarrage. Une seule source de
 * verite, aucun fichier charge deux fois.
 *
 * L'anglais est la langue de reference et le filet : une cle absente d'une
 * traduction retombe dessus plutot que d'afficher un identifiant technique.
 */

const FALLBACK = 'en';
const AVAILABLE = ['en', 'fr', 'es'];

const dictionaries = {};
let language = FALLBACK;

function load() {
  for (const code of AVAILABLE) {
    try {
      const file = path.join(__dirname, 'locales', `${code}.json`);
      dictionaries[code] = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      dictionaries[code] = {};
    }
  }
}

/** 'fr', 'en', ou n'importe quoi d'autre -> langue du systeme, sinon anglais. */
function resolve(preference) {
  if (AVAILABLE.includes(preference)) return preference;

  const locale = (app.getLocale() || '').slice(0, 2).toLowerCase();
  return AVAILABLE.includes(locale) ? locale : FALLBACK;
}

function init(preference) {
  load();
  language = resolve(preference);
  return language;
}

function setLanguage(preference) {
  language = resolve(preference);
  return language;
}

function t(key, vars) {
  const raw = dictionaries[language]?.[key] ?? dictionaries[FALLBACK]?.[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

/** Dictionnaire complet envoye au renderer, complete par l'anglais. */
function dict() {
  return { ...dictionaries[FALLBACK], ...dictionaries[language] };
}

module.exports = { init, setLanguage, t, dict, AVAILABLE, current: () => language };
