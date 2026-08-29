#!/usr/bin/env bash
# Genere tous les formats derives de la marque depuis les SVG de ce repertoire :
# icones de l'app (.ico, .png), tuiles MSIX, bitmaps de l'installeur NSIS.
#
# Rien dans le build ne depend de ce script : les rasters sont commites. On ne le
# lance qu'apres avoir modifie un SVG, puis on verifie les frames (identify) avant
# de committer.
#
# Dependances : librsvg (rsvg-convert) et ImageMagick 7 (magick). Sans rsvg, les
# degrades du SVG seraient rendus par le rasteriseur interne d'ImageMagick, qui
# les aplatit - c'est la raison pour laquelle on rasterise a la main.
#
#   sudo apt-get install librsvg2-bin imagemagick
#   assets/brand/make-icons.sh
set -euo pipefail

cd "$(dirname "$0")/../.."   # racine du depot
BRAND=assets/brand
APPX=installer/appx
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Les petites frames viennent d'un dessin allege (sans points ni bulle de fond) :
# a 16 et 24 px, ces details partent en bouillie a l'anticrepassage.
small() { [ "$1" -le 24 ] && echo "$BRAND/soocial-icon-$1.svg" || echo "$BRAND/soocial-app-icon.svg"; }

frame() {  # frame <px> <sortie.png> [source]
  local src="${3:-$(small "$1")}"
  rsvg-convert -w "$1" -h "$1" -o "$2" "$src"
}

echo "### Icones de l'app"
for s in 16 24 32 48 64 128 256; do
  frame "$s" "$WORK/i-$s.png"
done
# Le maitre sert aussi de PNG de 512 pour les cas agrandis (accueil, documents).
frame 512 "$WORK/i-512.png" "$BRAND/soocial-app-icon.svg"
# icon.png sert aux <img> du renderer : un .ico dans une balise img se solde par
# un cadre choisi au petit bonheur, un PNG 256 est net a toutes les echelles.
cp "$WORK/i-256.png" assets/icon.png

# L'ordre des frames est celui de Windows : la plus petite d'abord.
magick "$WORK/i-16.png" "$WORK/i-24.png" "$WORK/i-32.png" "$WORK/i-48.png" \
       "$WORK/i-64.png" "$WORK/i-128.png" "$WORK/i-256.png" \
  -define icon:auto-resize=16,24,32,48,64,128,256 \
  -depth 8 -strip assets/icon.ico
cp assets/icon.ico installer/icon.ico     # le meme fichier sert a l'installeur

echo "### Tuiles MSIX"
# Recette reprise de installer/appx/README.md : carre plein cadre, tuile large
# centree sur fond transparent (le fond vient du manifeste).
cp "$WORK/i-512.png" "$WORK/master.png"
sq() { magick "$WORK/master.png" -resize "${1}x${1}" -depth 8 -strip "$APPX/$2"; }

sq 44 Square44x44Logo.png
sq 55 Square44x44Logo.scale-125.png
sq 66 Square44x44Logo.scale-150.png
sq 88 Square44x44Logo.scale-200.png
sq 176 Square44x44Logo.scale-400.png

sq 150 Square150x150Logo.png
sq 188 Square150x150Logo.scale-125.png
sq 225 Square150x150Logo.scale-150.png
sq 300 Square150x150Logo.scale-200.png
sq 600 Square150x150Logo.scale-400.png

sq 50 StoreLogo.png
sq 63 StoreLogo.scale-125.png
sq 75 StoreLogo.scale-150.png
sq 100 StoreLogo.scale-200.png

for s in 16 24 32 48 256; do
  frame "$s" "$WORK/t-$s.png"
  magick "$WORK/t-$s.png" -depth 8 -strip "$APPX/Square44x44Logo.targetsize-$s.png"
  magick "$WORK/t-$s.png" -depth 8 -strip "$APPX/Square44x44Logo.targetsize-${s}_altform-unplated.png"
done

magick -size 310x150 xc:none \( "$WORK/master.png" -resize 100x100 \) -gravity center -composite -depth 8 -strip "$APPX/Wide310x150Logo.png"
magick -size 620x300 xc:none \( "$WORK/master.png" -resize 200x200 \) -gravity center -composite -depth 8 -strip "$APPX/Wide310x150Logo.scale-200.png"

echo "### Bitmaps de l'installeur"
# NSIS veut du BMP24 aux dimensions exactes : 150x57 pour l'entete, 164x314 pour
# la barre laterale. Un ecart d'un pixel et l'assistant etire l'image.
art() {  # art <nom-sans-extension>
  rsvg-convert -w "$2" -h "$3" -o "$BRAND/installer/$1.png" "$BRAND/installer/$1.svg"
  magick "$BRAND/installer/$1.png" -depth 8 -strip "installer/$1.bmp"
}
art installerHeader 150 57
art installerSidebar 164 314
art uninstallerSidebar 164 314

echo "### Visuels de documentation"
# Le hero du README et l'apercu social sont des dessins, pas des captures : une
# capture depend du reseau (les sites affichent leur page de connexion) et gele
# un etat qui n'existe plus des la version suivante.
# 16:9 pour le hero ; l'apercu social est le meme dessin rogne de 40 units en haut
# et en bas (son cadre 2:1), d'ou le rendu a 1280x720 avant le rogner.
rsvg-convert -w 2560 -h 1440 -o docs/hero.png "$BRAND/docs-hero.svg"
rsvg-convert -w 1280 -h 720 -o "$WORK/social.png" "$BRAND/docs-hero.svg"
magick "$WORK/social.png" -gravity center -crop 1280x640+0+0 +repage -depth 8 -strip docs/social-preview.png

echo "### Verification"
identify -format "%f %wx%h\n" assets/icon.png assets/icon.ico installer/icon.ico 2>/dev/null | sed -n '1,20p'
identify -format "%f %wx%h\n" installer/installerHeader.bmp installer/installerSidebar.bmp installer/uninstallerSidebar.bmp
echo "OK - relancer un build pour que l'installeur embarque ces fichiers"
