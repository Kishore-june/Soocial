'use strict';

/**
 * Identite produit, au seul endroit ou elle existe.
 *
 * Le nom "Soocial" apparait dans le package.json, le NSIS, le registre, le
 * raccourci, le repertoire de donnees et l'updater. Chacune de ces surfaces a
 * deja ete modifiee isolement dans un fork, et chacune de ces modifications a
 * laisse un etat incoherent : un raccourci qui pointe ailleurs, des donnees
 * orphelines, une mise a jour qui reinstalle sur C:. Ici, tout est derive.
 *
 * Les valeurs doivent rester identiques a celles de package.json (build.appId,
 * nsis.shortcutName) et de l'installateur NSIS — verifie par test/branding.mjs,
 * qui echoue si les deux listes divergent.
 */

const PRODUCT = {
  /** Nom affiche, tel qu'il doit apparaitre partout dans l'interface. */
  name: 'Soocial',
  /** Nom du produit tel que l'entend Windows (ARN, raccourci, titre). */
  productName: 'Soocial',
  /** Nom du paquet/dossier : le sous-dossier cree sous le choix de l'utilisateur. */
  dirName: 'Soocial',
  /** Nom de l'executable, sans extension. */
  executable: 'Soocial',
  /** Dossier de donnees sous %APPDATA% et %LOCALAPPDATA%. */
  dataDirName: 'Soocial',
  /** Id d'application Windows (AppUserModelID) — sert aussi aux notifications. */
  appId: 'com.soocial.desktop',
  /** Ce que l'installateur NSIS et l'app utilisent pour retrouver l'installation. */
  registryKey: 'Software\\Soocial',
  /** Nom du fichier d'enregistrement d'installation, a cote de l'exe. */
  metadataFile: 'install.json',
  /** Marqueur "installation en cours" pose par l'installateur, retire a la fin. */
  partialMarker: '.install-incomplete',
  /** Ce que la version precedente s'appelait — necessaire pour la migration. */
  legacy: {
    name: 'Nexus',
    dataDirName: 'Nexus',
    registryKey: 'Software\\Nexus',
    appId: 'com.mehdi.nexus',
  },
};

/** Ou le nom s'ecrit avec un complement de contexte (titre de fenetre, tray). */
const PRODUCT_TITLE = `${PRODUCT.name}`;
const PRODUCT_TAGLINE_KEY = 'about.tagline';

module.exports = { PRODUCT, PRODUCT_TITLE, PRODUCT_TAGLINE_KEY };
