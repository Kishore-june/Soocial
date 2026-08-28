'use strict';

/**
 * Reglages communs a tous les services.
 *
 * La liste des services elle-meme vit dans le store (config.json) : elle se
 * construit a l'onboarding du premier lancement, puis depuis l'app (bouton +,
 * clic droit). Ce fichier ne contient plus que les constantes partagees.
 */

// WhatsApp Web refuse les User-Agent contenant "Electron" (page "navigateur non
// supporte"). Les services qui le demandent se font passer pour un Chrome
// desktop standard. La plupart des sites n'en ont pas besoin.
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/**
 * Valeurs par defaut appliquees a tout service, d'ou qu'il vienne.
 *
 *   icon           fichier local dans assets/icons/ ou chemin absolu
 *   spoofUserAgent se faire passer pour Chrome (voir CHROME_UA)
 *   preload        charger des le demarrage ; false = au premier clic
 *   hibernateAfter minutes d'inactivite avant mise en veille automatique,
 *                  0 = jamais
 */
const SERVICE_DEFAULTS = {
  icon: null,
  spoofUserAgent: false,
  preload: true,
  hibernateAfter: 0,
};

module.exports = { SERVICE_DEFAULTS, CHROME_UA };
