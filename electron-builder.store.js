// Configuration du canal Microsoft Store.
//
// Elle reprend telle quelle celle de package.json — qui reste la source unique
// pour tout le reste — et y ajoute la seule difference d'empaquetage entre les
// deux canaux.
//
// Pourquoi un fichier plutot qu'une option : `files` ne se configure pas par
// cible dans electron-builder, et l'ecraser depuis la ligne de commande
// (`-c.files.7=...`) produit un objet la ou le schema attend un tableau, donc
// une configuration invalide. Le drapeau `--config` est la voie propre.

const { build } = require('./package.json');

module.exports = {
  ...build,
  files: [
    ...build.files,
    // Le paquet Store ne charge jamais electron-updater : les mises a jour
    // passent par le Store, et une application empaquetee ne peut pas reecrire
    // son propre paquet. L'embarquer laisserait dans l'asar un module qui lance
    // powershell.exe pour verifier des signatures — du code mort, signale par
    // le Windows App Certification Kit, et une surface inutile.
    '!node_modules/electron-updater/**',
  ],
};
