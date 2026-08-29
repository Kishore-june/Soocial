'use strict';

/**
 * Dimensions de la fenetre, definies une seule fois.
 *
 * Le projet amont avait ce reglage en double : SIDEBAR_WIDTH en chiffres dans
 * main.js, --sidebar-width en chiffres dans le CSS, avec un commentaire "doit
 * rester synchro". Un decalage de 4 px ne se voit pas dans la sidebar, il se
 * voit dans la vue du service : Discord ou WhatsApp decale, avec une bande du
 * contenu coupee par le bord. Ici la valeur vient du main, est passee au
 * renderer au bootstrap, et posee en variable CSS — il n'y a plus de synchro a
 * maintenir, donc plus de desynchronisation possible.
 *
 * TITLEBAR_HEIGHT existe depuis que la barre de titre est dessinee par l'app
 * (boutons a la mac sur Windows) : les WebContentsView sont positionnees en
 * coordonnees de zone client, donc tout ce qui est natif doit descendre d'autant.
 */

/** Largeur de la barre laterale developpee (et de la colonne d'icone). */
const SIDEBAR_WIDTH = 72;
/** Largeur une fois repliee : les icones seules, sans libelle. */
const SIDEBAR_WIDTH_COLLAPSED = 60;
/** Hauteur de la barre de titre personnalisee. */
const TITLEBAR_HEIGHT = 40;
/** Bande laissee libre entre les deux vues en mode partage, saisie a la souris. */
const SPLIT_GAP = 6;

/**
 * Petit coin : les trois pastilles mac. Elles mesurent 15 px et leur glyphe 8 px,
 * parce qu'a 24 px elles attiraient l'oeil plus que le titre de la fenetre, alors
 * qu'on ne les regarde que pour les retrouver. La zone cliquable reste plus large
 * que la pastille : le renderer l'etend de la moitie du pas entre deux boutons
 * (--window-button-gap / -2), donc les trois cibles se touchent sans se chevaucher.
 */
const WINDOW_BUTTON_SIZE = 15;
const WINDOW_BUTTON_GAP = 10;
const WINDOW_BUTTON_INSET = 12;
const WINDOW_GLYPH_SIZE = 8;

const METRICS = {
  SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_COLLAPSED,
  TITLEBAR_HEIGHT,
  SPLIT_GAP,
  WINDOW_BUTTON_SIZE,
  WINDOW_BUTTON_GAP,
  WINDOW_BUTTON_INSET,
  WINDOW_GLYPH_SIZE,
};

/** Payload envoye au renderer (et pose en variables CSS) a chaque bootstrap. */
function metricsForRenderer({ collapsed = false, glass = 'soft', theme = 'system' } = {}) {
  return {
    ...METRICS,
    sidebarWidth: collapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH,
    collapsed,
    glass,
    theme,
  };
}

module.exports = { ...METRICS, metricsForRenderer };
