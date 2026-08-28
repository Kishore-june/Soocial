# Ressources visuelles du paquet MSIX

electron-builder reprend tel quel ce qui se trouve ici et l'ecrit dans
`assets\` a l'interieur du paquet. Les noms sont imposes par Windows : un
fichier mal nomme n'est pas signale, il est simplement ignore et la tuile
retombe sur un placeholder gris.

Toutes les images derivent de `assets/brand/soocial-app-icon.svg`, la seule
source. Elles sont commitees, comme les BMP de l'installeur NSIS, pour que le
build ne dependre pas d'ImageMagick.

## Regeneration

Depuis la racine du depot, avec ImageMagick 7 et son delegue SVG (`rsvg-convert`) :

```bash
magick -background none -density 1200 assets/brand/soocial-app-icon.svg -resize 1024x1024 master.png

# Tuiles carrees : l'icone porte deja sa plaque arrondie, donc plein cadre.
sq() { magick master.png -resize "${1}x${1}" -depth 8 -strip "installer/appx/$2"; }

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

# Barre des taches, Alt+Tab, liste du menu Demarrer. Les variantes unplated
# sont affichees sans le carre de fond ajoute par Windows : l'icone ayant sa
# propre plaque blanche, un second fond la ferait flotter dans un cadre.
for s in 16 24 32 48 256; do
  sq $s "Square44x44Logo.targetsize-${s}.png"
  sq $s "Square44x44Logo.targetsize-${s}_altform-unplated.png"
done

# Tuile large : l'icone centree, le reste transparent. Le fond vient de
# l'attribut BackgroundColor du manifeste (#1e1e2e).
magick -size 310x150 xc:none \( master.png -resize 100x100 \) -gravity center -composite -depth 8 -strip installer/appx/Wide310x150Logo.png
magick -size 620x300 xc:none \( master.png -resize 200x200 \) -gravity center -composite -depth 8 -strip installer/appx/Wide310x150Logo.scale-200.png
```

## Volontairement absents

- **BadgeLogo.png** — declencherait `<uap:LockScreen>` dans le manifeste, donc
  une declaration d'ecran de verrouillage dont l'app n'a pas l'usage.
- **SplashScreen.png** — ignore pour une application full-trust : l'ecran de
  demarrage est un mecanisme UWP.

Les ajouter n'est pas neutre : electron-builder les detecte par leur nom et
ajoute l'element de manifeste correspondant, qui devient une surface de plus a
justifier a la certification.
