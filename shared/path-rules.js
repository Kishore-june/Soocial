'use strict';

/**
 * Regles de chemins Windows — la source de verite unique.
 *
 * Pourquoi un fichier partage et pas deux implcmentations : la validation est
 * faite deux fois, par deux langages differents (NSIS a l'installation, JS au
 * premier lancement et dans les reglages). Des que les deux divergent, on obtient
 * le pire scenario possible : l'installateur accepte un chemin que l'app refuse, ou
 * l'app reecrit ailleurs ce que l'installateur a pose. Ce module enonce la regle,
 * l'installateur la traduit, l'app l'applique — et un test verifie qu'ils disent la
 * meme chose sur les memes entrees.
 *
 * Tout est pur ici : pas de fs, pas d'electron. Les faits (le dossier existe-t-il,
 * est-il inscriptible, le lecteur est-il branche) sont passes en arguments par
 * l'appelant. C'est ce qui rend la logique testable sous Linux,-la ou l'installateur
 * ne tourne pas.
 */

/** Nom du sous-dossier cree sous le dossier choisi par l'utilisateur. */
const PRODUCT_DIR = 'Soocial';

/**
 * Limite pratique avant laquelle on avertit. MAX_PATH est a 260 caracteres, et
 * l'app doit laisser de la place aux sous-chemins qu'elle ajoute elle-meme
 * (Partitions/persist:<id>/Local Storage/leveldb, Log/...). 240 laisse ~20
 * caracteres de marge : insuffisant pour etre confortable, suffisant pour ne pas
 * mentir sur ce qui est mesure.
 */
const PATH_WARN_LENGTH = 240;
const PATH_MAX_LENGTH = 259;

const RESERVED_NAMES = [
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
];

/** Caractere interdit par NTFS/FAT dans un nom de fichier ou de dossier. */
const INVALID_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;

/**
 * Idem, mais applique a UN maillon : le separateur est deja sorti du jeu. Le `/`
 * y reste parce qu'un maillon qui en contient n'est pas un maillon.
 */
const INVALID_SEGMENT_CHARS = /[<>:"|?*\u0000-\u001f/]/;

/** Retire ce qui, au debut d'un chemin, n'est pas un maillon : \\?\, `D:`, \\serveur\part. */
function stripKnownPrefixes(p) {
  let out = p.replace(/^\\\\[?.]\\/, '');
  if (/^[a-zA-Z]:/.test(out)) out = out.slice(2);
  else if (UNC_PREFIX.test(out)) {
    const parts = out.split('\\');
    out = parts.slice(4).join('\\'); // \\serveur\part\... -> ...
  }
  return out;
}

/** Un chemin absolu Windows : lecteur ("D:\"), UNC ("\\serveur\part") ou prefixe \\?\. */
const DRIVE_ROOT = /^([a-zA-Z]):[\\/]/;
const UNC_PREFIX = /^\\\\[^\\]/;
const EXTENDED_PREFIX = /^\\\\[?.]\\/;

/**
 * Met un chemin sous sa forme canonique, cote windows : anti-slash, pas de
 * separateur duplique, pas de separateur final, ni de point ou d'espace de fin
 * (Windows les ignore silencieusement — un "MaDossier." designe "MaDossier", et
 * garder le point dans la chaine stockee creerait deux chemins distincts sur le
 * papier et le meme sur disque).
 *
 * Le prefixe "\\?\" est preserve : c'est lui qui desactive l'analyse de MAX_PATH,
 * donc le seul qui rende les chemins longs reellement utilisables.
 */
function normalize(input) {
  if (typeof input !== 'string') return '';

  let out = input.trim().replace(/\//g, '\\');
  const extended = EXTENDED_PREFIX.test(out);
  if (extended) out = out.slice(4);

  // Le lecteur "D:" sans barre est une racine : ne pas le traiter comme un
  // chemin relatif, sinon "D:" devient "D:\\..." par concatenation et le test
  // "est-ce absolu" repond faux.
  // "D:" et "D:\" sont la meme chose : le test doit accepter la barre, sinon la
  // racine d'un lecteur ressort normalisee sans separateur et ne se compare plus
  // a rien (ni a rootOf, ni a la table des lecteurs de Windows).
  const isBareDrive = /^[a-zA-Z]:\\?$/.test(out);

  out = out.replace(/\\{2,}/g, '\\');
  if (!extended && !UNC_PREFIX.test(out)) out = out.replace(/\\+$/, '');
  if (UNC_PREFIX.test(out)) out = out.replace(/\\+$/, '');

  if (!extended) {
    // Deux passes, dans cet ordre : enlever le point final de "D:\Apps\." laisse
    // "D:\Apps\", qu'une seule coupe de queue laisse donc avec un separateur
    // orphelin - et deux chemins qui ne se ressemblent pas ne passent pas le test
    // samePath, ce qui suffit a faire croire a une installation differente.
    out = out.replace(/[ .]+$/, '').replace(/\\+$/, '').replace(/[ .]+$/, '');
    if (isBareDrive && !out.endsWith('\\')) out += '\\';
    // Un dossier "D:\Apps\." ou "D:\Apps\foo\.." doit etre plie avant
    // comparaison : sinon "D:\Apps" et "D:\Apps\.." passent pour differents.
    out = collapseDots(out);
  }

  if (isBareDrive && !out.endsWith('\\')) out += '\\';
  return extended ? `\\?\${out}` : out;
}

function collapseDots(p) {
  if (!p) return p;
  const sep = UNC_PREFIX.test(p) ? '\\\\' : undefined;
  const parts = p.split('\\');
  const out = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      const canClimb = out.length && out[out.length - 1] !== '' && !/^[a-zA-Z]:$/.test(out[out.length - 1]);
      // Au-dessus de la racine, il n'y a rien : un `..` qui ne peut pas monter
      // est jete au lieu d'etre ecrit tel quel. "D:\..\Windows" est bien
      // equivalent a "D:\Windows" pour Windows, mais c'est la chaine qui part
      // dans install.json, dans le registre et dans les comparaisons -- et un
      // `..` stocke se lit comme un doute.
      if (canClimb) {
        out.pop();
        continue;
      }
      continue;
    }
    out.push(part);
  }
  let joined = out.join('\\');
  if (sep && !joined.startsWith(sep)) joined = joined.replace(/^[^\\]/, (c) => `${sep}${c}`);
  return joined;
}

function isAbsolute(input) {
  const p = normalize(input);
  return DRIVE_ROOT.test(p) || p.startsWith('\\\\') || /^[a-zA-Z]:\\?$/.test(p);
}

/** "D:\\Apps\\Soocial" -> "D:". Renvoie '' pour un UNC (pas de lecteur au sens du test de presence). */
function driveOf(input) {
  const match = DRIVE_ROOT.exec(normalize(input));
  return match ? `${match[1].toUpperCase()}:` : '';
}

/** Racine du chemin : "D:" -> "D:\\", "D:\\a\\b" -> "D:\\" ; pour un UNC, la part du partage. */
function rootOf(input) {
  const p = normalize(input);
  if (DRIVE_ROOT.test(p)) return `${p.slice(0, 2)}\\`;
  if (p.startsWith('\\\\')) {
    const parts = p.slice(2).split('\\');
    return `\\\\${parts[0]}\\${parts[1] || ''}`.replace(/\\$/, '');
  }
  return '';
}

/** Vrai si `child` est `parent` lui-meme ou l'un de ses descendants (insensible a la casse). */
function isPathInside(parent, child) {
  const a = normalize(parent).toLowerCase().replace(/\\$/, '');
  const b = normalize(child).toLowerCase();
  if (!a || !b) return false;
  return b === a || b.startsWith(`${a}\\`);
}

function samePath(a, b) {
  const x = normalize(a).toLowerCase().replace(/\\+$/, '');
  const y = normalize(b).toLowerCase().replace(/\\+$/, '');
  return Boolean(x) && x === y;
}

/** Dernier maillon du chemin ("D:\\a\\b" -> "b"), sans separateur ni point final. */
function baseOf(input) {
  const p = normalize(input).replace(/\\+$/, '');
  const index = p.lastIndexOf('\\');
  return index === -1 ? p : p.slice(index + 1);
}

/** Dossier parent ("D:\\a\\b" -> "D:\\a") ; '' si on est deja a la racine. */
function parentOf(input) {
  const p = normalize(input).replace(/\\+$/, '');
  const index = p.lastIndexOf('\\');
  if (index <= 1) return ''; // racine de lecteur, ou chemin sans parent
  return p.slice(0, index);
}

/** "CON.txt", "nul", "com1" : refuses par Windows dans les deux cas. */
function isReservedName(name) {
  const stem = String(name || '').split('.')[0].toUpperCase();
  return RESERVED_NAMES.includes(stem);
}

/** Nom de dossier/fichier licite (un seul maillon, pas un chemin). */
function isNameValid(name) {
  if (typeof name !== 'string' || !name) return false;
  if (INVALID_NAME_CHARS.test(name)) return false;
  if (/[. ]$/.test(name)) return false;
  return !isReservedName(name);
}

/**
 * Chemin complet licite : absolu, sans caractere interdit, sans segment reserve,
 * et de longueur exploitable. La longueur est un avertissement, pas un refus :
 * Windows 10 sait faire, mais uniquement si l'application est marquee "long path
 * aware" et que la politique systeme est activee. Promettre mont sur un chemin de
 * 300 caracteres serait mentir a l'utilisateur.
 */
function validatePath(input, { mustBeAbsolute = true } = {}) {
  const issues = [];
  const p = normalize(input);

  if (!p) return { ok: false, path: p, issues: [{ code: 'EMPTY' }] };
  if (mustBeAbsolute && !isAbsolute(p)) issues.push({ code: 'NOT_ABSOLUTE' });

  // Un caractere interdit s'apprecie maillon par maillon, jamais sur le chemin
  // entier. `\` est le separateur et `:` suit la lettre de lecteur : les chercher
  // dans toute la chaine (ce que faisait cette fonction) declare INVALID_CHARS
  // 100 % des chemins Windows, y compris C:\Program Files\Soocial - et un refus
  // aussi universel que celui-la ne se remarque que chez l'utilisateur, parce que
  // le test qui l'aurait vu n'existait pas encore.
  const body = stripKnownPrefixes(p);
  const segments = body.split('\\').filter(Boolean);

  const bad = segments.filter((segment) => INVALID_SEGMENT_CHARS.test(segment) || /[. ]$/.test(segment));
  // Un deuxieme `:` ailleurs qu'apres la lettre de lecteur est interdit.
  if (body.includes(':')) bad.push(':');
  if (bad.length) issues.push({ code: 'INVALID_CHARS', names: bad.slice(0, 3) });

  const reserved = segments.filter((segment) => isReservedName(segment));
  if (reserved.length) issues.push({ code: 'RESERVED_NAME', names: reserved });

  const length = p.length;
  if (length > PATH_MAX_LENGTH) issues.push({ code: 'TOO_LONG', length });
  else if (length > PATH_WARN_LENGTH) issues.push({ code: 'LONG_PATH', length });

  return { ok: !issues.some((i) => i.code !== 'LONG_PATH'), path: p, issues };
}
/**
 * Regle numero 1 de l'installation : l'utilisateur choisit le dossier PARENT,
 * l'app est installee dans un sous-dossier Soocial. Previsible pour lui, et surtout
 * indispensable a l'installateur : il ne peut supprimer que ce qui est sous
 * <parent>\Soocial. Un dossier "Photoshop" voisin ne court aucun risque.
 *
 * Seule entorse assumee, et elle est la pour eviter l'accident inverse : si le
 * dossier choisi s'appelle deja "Soocial" et n'est pas une racine de lecteur,
 * c'est qu'il a ete cree pour cela. On l'utilise tel quel plutot que de produire
 * le "Soocial\Soocial" que personne n'a demande.
 */
function resolveTargetDirectory(parent, options = {}) {
  const product = options.product || PRODUCT_DIR;
  const normalized = normalize(parent);

  if (!normalized) return { target: '', parent: '', createdSubfolder: false, error: 'EMPTY' };
  if (!isAbsolute(normalized)) {
    return { target: '', parent: normalized, createdSubfolder: false, error: 'NOT_ABSOLUTE' };
  }

  const root = rootOf(normalized);
  const isDriveRoot = samePath(normalized, root);
  const namedLikeProduct = baseOf(normalized).toLowerCase() === product.toLowerCase();

  if (namedLikeProduct && !isDriveRoot) {
    return { target: normalized, parent: parentOf(normalized), createdSubfolder: false, product };
  }

  // Le jointoiement n'est pas une concatenation : `D:\` se termine deja par un
  // separateur, et `D:\\Soocial` est un chemin que Windows accepte mais que
  // nothing d'autre ne reconnait -- ni samePath (qui replie), ni l'utilisateur
  // qui lit install.json, ni le registre ou l'updater relit la valeur.
  const base = normalized.replace(/\\+$/, '');
  return { target: `${base}\\${product}`, parent: normalized, createdSubfolder: true, product };
}

/**
 * Ce que l'installateur doit refuser, et dans quel ordre. L'ordre compte :
 * signaler "pas le droit d'ecrire" sur un lecteur debranche est inutile —
 * la vraie cause est la premiere. Chaque cle a une entree dans les fichiers de
 * langue, pour que le message soit compris, pas seulement code.
 *
 * @param {string} target chemin final (<parent>\Soocial)
 * @param {object} facts releves par l'appelant (fs cote installateur, electron cote app)
 */
function classifyTarget(target, facts = {}) {
  const shape = validatePath(target);
  if (!shape.ok) {
    const blocking = shape.issues.find((issue) => issue.code !== 'LONG_PATH');
    return { valid: false, code: blocking ? blocking.code : 'LONG_PATH', issues: shape.issues };
  }

  const drive = driveOf(target);
  const root = rootOf(target);

  // La liste des lecteurs vient de deux endroits differents (GetLogicalDrives
  // cote NSIS, `fs` + `drives` cote app) et l'un rend "D:\", l'autre "D:". Les
  // deux sont la meme information : c'est ici qu'on la met d'accord, pas chez
  // chaque appelant -- un appelant qui oublie fait croire a un lecteur absent et
  // refuse une installation parfaitement valide.
  if (drive && facts.drives) {
    const present = new Set((facts.drives || []).map((entry) => driveOf(entry) || String(entry).replace(/[\\/]+$/, '')).filter(Boolean));
    if (!present.has(drive)) return { valid: false, code: 'DRIVE_UNAVAILABLE', drive };
  }
  if (facts.exists && facts.isSameNameAsParent) {
    return { valid: false, code: 'NESTED_ROOT', target };
  }
  if (root && samePath(target, root)) {
    // Installer a la racine d'un lecteur melangerait Soocial.exe aux fichiers de
    // l'utilisateur, et desinstallateur n'aurait aucun perimetre. Refuse net.
    return { valid: false, code: 'IS_DRIVE_ROOT', target };
  }
  if (facts.exists && facts.isFile) {
    return { valid: false, code: 'NOT_A_DIRECTORY', target };
  }
  if (!facts.exists && facts.parentWritable === false) {
    return { valid: false, code: 'NO_PERMISSION', target, where: 'parent' };
  }
  if (facts.exists && facts.writable === false) {
    return { valid: false, code: 'NO_PERMISSION', target, where: 'target' };
  }
  if (facts.exists && facts.hasInstall && !facts.allowExisting) {
    return { valid: false, code: 'ALREADY_INSTALLED', target, version: facts.installedVersion || null };
  }
  if (facts.exists && facts.hasForeignFiles && !facts.allowForeign) {
    // Dossier deja peuple par autre chose : on n'y installe pas sans accord explicite,
    // sinon la desinstallation future devrait deviner ce qui lui appartient.
    return { valid: false, code: 'NOT_EMPTY', target, entries: facts.foreignEntries || [] };
  }

  return { valid: true, code: 'OK', issues: shape.issues, target: shape.path };
}

const ERROR_KEYS = {
  EMPTY: 'path.error.empty',
  NOT_ABSOLUTE: 'path.error.notAbsolute',
  INVALID_CHARS: 'path.error.invalidChars',
  RESERVED_NAME: 'path.error.reserved',
  TOO_LONG: 'path.error.tooLong',
  LONG_PATH: 'path.error.longPath',
  DRIVE_UNAVAILABLE: 'path.error.driveMissing',
  NO_PERMISSION: 'path.error.noPermission',
  NOT_A_DIRECTORY: 'path.error.notADirectory',
  IS_DRIVE_ROOT: 'path.error.driveRoot',
  NESTED_ROOT: 'path.error.nestedRoot',
  ALREADY_INSTALLED: 'path.error.alreadyInstalled',
  NOT_EMPTY: 'path.error.notEmpty',
};

function errorKeyFor(code) {
  return ERROR_KEYS[code] || 'path.error.unknown';
}

/**
 * Nettoie un nom de fichier propose par un site. On ne supprime pas a l'aveugle :
 * les caracteres autorises en Unicode (chinois, accentues, emoji) sont conserves,
 * seuls les interdits Windows tombent. Un nom vide ou reserve recoit `fallback`.
 */
function sanitizeFileName(name, fallback = 'download') {
  let out = String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/[. ]+$/, '').trim();

  if (isReservedName(out)) out = `_${out}`;

  const dot = out.lastIndexOf('.');
  const base = dot > 0 ? out.slice(0, dot) : out;
  const ext = dot > 0 ? out.slice(dot) : '';
  const maxBase = 120 - ext.length;
  out = (base.length > maxBase ? base.slice(0, maxBase) : base) + ext;

  return out || fallback;
}

/**
 * Nom definitive pour ne jamais ecraser sans accord : "rapport.pdf", puis
 * "rapport (2).pdf", "rapport (3).pdf"... La numerotation est reprise a 2 pour
 * coller a ce que fait Explorer, donc a ce a quoi l'utilisateur s'attend.
 */
function uniqueFileName(base, extension, existing, limit = 999) {
  const candidate = (n) => (n === 1 ? `${base}${extension}` : `${base} (${n})${extension}`);
  const taken = new Set((existing || []).map((name) => String(name).toLowerCase()));

  for (let n = 1; n <= limit; n++) {
    const name = candidate(n);
    if (!taken.has(name.toLowerCase())) return name;
  }
  return `${base}-${Date.now()}${extension}`;
}

/**
 * Decision de rattrapage apres une installation interrompue. Le marqueur
 * d'inacheve ecrit par l'installateur ne suffit pas : il faut aussi que le dossier
 * n'ait pas ete valide depuis (sinon on efface une installation qui fonctionne,
 * ce qui est pire que le dossier orphelin qu'on voulait ranger).
 */
function shouldCleanPartialInstall({ markerPresent, verifiedMarkerPresent, hasInstallInfo }) {
  if (!markerPresent) return false;
  if (verifiedMarkerPresent) return false;
  if (hasInstallInfo) return false;
  return true;
}

/**
 * Garde-fou de desinstallation : ce que le desinstallateur a le droit de vider.
 *
 * Le dossier du produit, et uniquement lui. Trois refus, trois accidents differents :
 *   - la racine d'un lecteur (`D:\`), ou le desinstallateur se retrouverait a
 *     formater le disque aux yeux de l'utilisateur ;
 *   - le PARENT choisi (`D:\Apps`), qui contient Photoshop, les documents, tout ;
 *   - un dossier qui ne s'appelle meme pas Soocial : a ce stade le registre a mente
 *     (dossier renomme a la main, cle recopiee d'une autre machine), et un
 *     `RMDir /r` sur une confiance perdue est la pire chose a faire.
 *
 * Les sous-dossiers du produit sont autorises parce que la restauration d'une
 * installation inachevee les nettoie, elle aussi.
 */
function canRemoveDirectory(dir, installDir, product = PRODUCT_DIR) {
  const target = normalize(dir);
  const root = normalize(installDir);
  if (!target || !root) return false;
  if (samePath(target, rootOf(root))) return false;
  if (samePath(target, root)) return baseOf(root).toLowerCase() === String(product).toLowerCase();
  return isPathInside(root, target);
}

module.exports = {
  PRODUCT_DIR,
  PATH_WARN_LENGTH,
  PATH_MAX_LENGTH,
  RESERVED_NAMES,
  normalize,
  isAbsolute,
  driveOf,
  rootOf,
  isPathInside,
  samePath,
  baseOf,
  parentOf,
  isReservedName,
  isNameValid,
  validatePath,
  resolveTargetDirectory,
  classifyTarget,
  errorKeyFor,
  sanitizeFileName,
  uniqueFileName,
  shouldCleanPartialInstall,
  canRemoveDirectory,
};
