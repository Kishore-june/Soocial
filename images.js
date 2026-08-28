'use strict';

const { nativeImage } = require('electron');

// Score attribue aux icones vectorielles : elles restent nettes a n'importe
// quelle taille, elles doivent donc battre n'importe quel bitmap.
const SVG_SCORE = 4096;

/**
 * Determine le vrai format a partir des octets. Les serveurs mentent ou se
 * taisent : web.whatsapp.com sert sa favicon en WebP sans content-type
 * exploitable. Les nombres magiques, eux, ne mentent pas.
 */
function sniffMime(buffer, fallback) {
  if (buffer.length >= 4) {
    if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) {
      return 'image/x-icon';
    }
    if (buffer[0] === 0x89 && buffer.toString('latin1', 1, 4) === 'PNG') return 'image/png';
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
    if (buffer.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
    if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
      return 'image/webp';
    }
  }

  // Tout ce qui commence par "<" n'est pas du SVG. Les applications monopage
  // renvoient leur index.html en 200 sur n'importe quel chemin inconnu :
  // /apple-touch-icon.png retourne alors une page complete, qu'on prendrait
  // pour une icone vectorielle — donc la mieux notee de toutes.
  const head = buffer.toString('utf8', 0, 600).trimStart().toLowerCase();
  if (head.startsWith('<')) {
    if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
      return 'image/svg+xml';
    }
    return 'text/html';
  }

  return fallback;
}

/**
 * Largeur d'un WebP, lue dans son en-tete. nativeImage ne decode pas ce format
 * (Chromium si, l'icone s'affiche donc normalement) et web.whatsapp.com sert sa
 * favicon en WebP : sans ca elle serait scoree 0 et perdrait face a n'importe
 * quelle favicon dynamique de 16px.
 */
function webpWidth(buffer) {
  if (buffer.length < 30) return 0;

  switch (buffer.toString('latin1', 12, 16)) {
    case 'VP8X': // etendu : largeur du canvas sur 3 octets, moins 1
      return buffer.readUIntLE(24, 3) + 1;
    case 'VP8 ': // avec perte : 14 bits apres le sync code
      return buffer.readUInt16LE(26) & 0x3fff;
    case 'VP8L': // sans perte : 14 bits apres la signature, moins 1
      return (buffer.readUInt32LE(21) & 0x3fff) + 1;
    default:
      return 0;
  }
}

/**
 * Meilleure frame d'un fichier .ico.
 *
 * Un .ico est un conteneur : il embarque la meme icone en 16, 32, 48, 128 et
 * 256px. On n'en affiche qu'une seule, mais on stockait le lot — d'ou des
 * vignettes a 80 Ko. La table des matieres se lit en quelques octets.
 *
 * Renvoie la largeur de la plus grande frame, et son contenu quand il est deja
 * en PNG (le cas courant pour les grandes tailles). Une frame en BMP brut n'est
 * pas extraite : nativeImage ne saurait pas la relire hors de son conteneur.
 */
const ICO_TARGET = 128; // taille suffisante pour un affichage a 44px, meme en HiDPI

function readIco(buffer) {
  if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) return null;

  const count = buffer.readUInt16LE(4);
  const frames = [];

  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16;
    if (entry + 16 > buffer.length) break;

    const width = buffer.readUInt8(entry) || 256; // 0 signifie 256
    const size = buffer.readUInt32LE(entry + 8);
    const offset = buffer.readUInt32LE(entry + 12);
    if (offset + size > buffer.length) continue;

    const data = buffer.subarray(offset, offset + size);
    const isPng = data.length > 8 && data[0] === 0x89 && data.toString('latin1', 1, 4) === 'PNG';

    frames.push({ width, isPng, data, entry: buffer.subarray(entry, entry + 16) });
  }

  if (!frames.length) return null;

  // On ne cherche pas la plus grande frame mais la plus petite qui suffise.
  // Une frame de 256px en BMP brut pese 256 Ko a elle seule, pour un logo
  // affiche a 44px — et les frames PNG sont toujours preferables a taille egale.
  const usable = frames.filter((frame) => frame.width >= ICO_TARGET);
  const pool = usable.length ? usable : frames;
  const best = pool.sort(
    (a, b) => a.width - b.width || Number(b.isPng) - Number(a.isPng)
  )[0];

  return { width: Math.max(...frames.map((frame) => frame.width)), best };
}

/**
 * Reconstruit un .ico ne contenant qu'une seule frame. Utile quand la frame
 * retenue est en BMP brut : elle n'est pas exploitable seule, mais reste
 * affichable une fois remise dans un conteneur minimal.
 */
function packIco(frame) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);

  const entry = Buffer.from(frame.entry); // on garde planes et bitCount d'origine
  entry.writeUInt32LE(frame.data.length, 8);
  entry.writeUInt32LE(header.length + 16, 12);

  return Buffer.concat([header, entry, frame.data]);
}

/** Score de qualite d'une icone = sa largeur en pixels. */
function iconWidth(candidate) {
  if (/svg/i.test(candidate.mime)) return SVG_SCORE;
  if (/webp/i.test(candidate.mime)) return webpWidth(candidate.buffer);
  // Pour le score on prend la plus grande frame du conteneur : c'est elle qui
  // dit la qualite reelle de l'icone, meme si on n'en stockera pas autant.
  if (/icon/i.test(candidate.mime)) return readIco(candidate.buffer)?.width || 128;

  return nativeImage.createFromBuffer(candidate.buffer).getSize().width || 0;
}

/** Decode une data URI en buffer, pour la comparer aux favicons telechargees. */
function decodeDataUrl(url) {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url);
  if (!match) return null;

  const [, mime, base64, payload] = match;
  return {
    mime: mime || 'image/png',
    buffer: base64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8'),
  };
}

function toDataUrl(candidate) {
  return `data:${candidate.mime};base64,${candidate.buffer.toString('base64')}`;
}

module.exports = {
  SVG_SCORE,
  sniffMime,
  webpWidth,
  readIco,
  packIco,
  iconWidth,
  decodeDataUrl,
  toDataUrl,
};
