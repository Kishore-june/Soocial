#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Verification de l'installateur, sans Windows.
#
# Ce script ne remplace pas les tests d'installation sur machine reelle (la
# matrice est dans docs/INSTALLATION.md) : il verifie ce qui est verifiable ici,
# a savoir que installer/custom.nsh se COMPILE dans le contexte de
# electron-builder, avec la MEME version de makensis que la production.
#
# Pourquoi ca vaut le coup : l'ordre d'inclusion de NSIS est un piege a
# lui seul. Un !define place trop tard, une Var declaree apres usage, un ${If}
# ecrit la ou LogicLib n'existe pas encore, une macro jamais expandee (le corps
# d'une !macro non appelee n'est PAS verifie) : autant d'erreurs qui ne
# sortent qu'a makensis, c'est-a-dire au milieu d'un build de release.
#
# makensis est cherche dans cet ordre : argument, $MAKENSIS, le cache
# electron-builder, le makensis systeme.
# -----------------------------------------------------------------------------
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
templates="$root/node_modules/app-builder-lib/templates/nsis"

find_makensis() {
  if [[ -n "${1:-}" ]]; then echo "$1"; return; fi
  if [[ -n "${MAKENSIS:-}" ]]; then echo "$MAKENSIS"; return; fi
  local cached
  cached=$(ls -d "$HOME"/.cache/electron-builder/nsis-*/nsis-*/linux/makensis 2>/dev/null | head -1 || true)
  [[ -n "$cached" ]] && { echo "$cached"; return; }
  cached=$(ls -d "$HOME"/.cache/electron-builder/nsis-*/nsis-*/Bin/makensis 2>/dev/null | head -1 || true)
  [[ -n "$cached" ]] && { echo "$cached"; return; }
  command -v makensis || true
}

makensis="$(find_makensis "${1:-}")"
if [[ -z "$makensis" ]]; then
  echo "FAIL  makensis introuvable (installer le paquet nsis, ou lancer un build electron-builder une fois pour peupler son cache)" >&2
  exit 2
fi
if [[ ! -d "$templates" ]]; then
  echo "FAIL  modeles NSIS de electron-builder absents - lancer npm install" >&2
  exit 2
fi

workdir="${NSI_WORK:-$(mktemp -d)}"
mkdir -p "$workdir"
[[ -n "${NSI_WORK:-}" ]] || trap "rm -rf $workdir" EXIT

# --- sonde de capacite : LogSet ----------------------------------------------
# Un makensis construit sans NSIS_CONFIG_LOG rejette `LogSet on` d'une erreur
# irrattrapable, et le harnais accuserait alors notre script pour un defaut du
# paquet. On le sait en le compilant une fois, et on passe le define qui va bien.
cat > "$workdir/logset-probe.nsi" <<'NSI'
Unicode true
OutFile "__WORK__/logset-probe.exe"
Section
  LogSet on
SectionEnd
NSI
sed -i -e "s|__WORK__|$workdir|g" "$workdir/logset-probe.nsi"
harness_defines=()
if ! "$makensis" -V1 "$workdir/logset-probe.nsi" >"$workdir/logset-probe.log" 2>&1; then
  echo "  note  : makensis sans NSIS_CONFIG_LOG (paquet systeme) - le hook LogSet est exclu de la compilation"
  harness_defines+=(-DSOO_NO_LOGSET)
fi
rm -f "$workdir/logset-probe.exe"

# --- harnais installeur ------------------------------------------------------
# Reproduit l'ordre reel : en-tete genere (notre include), puis le modele.
cat > "$workdir/installer.nsi" <<'NSI'
!addincludedir "__TEMPLATES__"
!addincludedir "__TEMPLATES__/include"
!addincludedir "__ROOT__/installer"

Unicode true
; Pas de Name ici : common.nsh le pose a partir de ${PRODUCT_NAME}, et le repeter
; vaudrait un 6029 que -WX transforme en echec du harnais, pas du script.
OutFile "__WORK__/installer.exe"
ManifestDPIAware true
RequestExecutionLevel user

!include "custom.nsh"

!include "common.nsh"
!include "MUI2.nsh"
!include "LogicLib.nsh"

; Vars que le modele declare avant customHeader dans la vraie vie (multiUser.nsh
; pour installMode, le haut de installer.nsi pour les liens). Ici elles sont
; declarees au MEME endroit : une Var declaree apres son usage ne casse pas le
; build de production, mais elle en casse la lecture - et l'inverse est une
; erreur que notre script ne revele que par un warning.
; Les deux cles de registre que le modele definit dans multiUser.nsh avant nos
; macros. Le harnais ne peut pas inclure ce fichier-la : "multiUser.nsh" est aussi
; le nom d'un include de NSIS, et la version de NSIS exige MULTIUSER_EXECUTIONLEVEL.
; Reproduire les deux lignes coute moins cher qu'un faux positif - et sans elles,
; un ${INSTALL_REGISTRY_KEY} dans nos fonctions deviendrait un "unknown variable"
; que le harnais avalerait en avertissement.
!define /ifndef INSTALL_REGISTRY_KEY "Software\${APP_GUID}"
!define /ifndef UNINSTALL_REGISTRY_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"
Var installMode
Var appExe
Var newStartMenuLink
Var newDesktopLink
Var hasPerMachineInstallation
Var hasPerUserInstallation
Var perMachineInstallationFolder
Var perUserInstallationFolder

; Ordre reel du modele : les pages AVANT addLangs, puis customHeader. Un
; LangString ou un MUI_* pose dans le desordre ne casse pas le build, il casse
; la langue affichee - et c'est justement ce que le harnais doit pouvoir voir.
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES

; Les noms doivent etre ceux que electron-builder ecrit, pas ceux qui semblent
; logiques : il traduit "es" en SpanishInternational, et NSIS traite Spanish et
; SpanishInternational comme deux tables distinctes. Inserez "Spanish" ici et un
; LangString absent de la table espagnole passe inapercu -- c'est exactement le
; bug que la production a revele, sous forme d'avertissement 6040 que
; electron-builder transforme en erreur avec -WX.
!macro addLangs
  !insertmacro MUI_LANGUAGE "English"
  !insertmacro MUI_LANGUAGE "French"
  !insertmacro MUI_LANGUAGE "SpanishInternational"
!macroend

!insertmacro addLangs
!insertmacro customHeader

Function .onInit
  !insertmacro customInit
FunctionEnd

Section "install" 0
  ; Un dossier qui ressemble a ce que l'installateur rencontre vraiment.
  StrCpy $INSTDIR "$PROGRAMFILES64\Soocial"
  CreateDirectory "$INSTDIR"
  Call soocialPrepare
  Call soocialWriteMetadata
  !insertmacro customInstall
SectionEnd
NSI

# --- harnais desinstallateur -------------------------------------------------
cat > "$workdir/uninstaller.nsi" <<'NSI'
!addincludedir "__TEMPLATES__"
!addincludedir "__TEMPLATES__/include"
!addincludedir "__ROOT__/installer"

; Le desinstallateur est compile deuxieme, avec BUILD_UNINSTALLER defini, sur le
; MEME script (voir NsisTarget.computeScriptAndSignUninstaller) : c'est ce define
; qui fait basculer chaque !ifdef de custom.nsh. Le harnais doit donc passer ce
; define, sinon cette moitie du fichier n'est jamais verifiee.
Unicode true
; Idem : le Nom appartient au modele, pas au harnais.
OutFile "__WORK__/uninstaller.exe"
RequestExecutionLevel user
SilentInstall silent

!include "custom.nsh"

!include "common.nsh"
!include "MUI2.nsh"
!include "LogicLib.nsh"

; multiUser.nsh declare $installMode et definit ${INSTALL_REGISTRY_KEY} /
; ${UNINSTALL_REGISTRY_KEY} : le modele l'insere avant nos macros, donc le harnais
; l'insere aussi plutot que de declarer la Var a la main. Sans lui, un
; ${INSTALL_REGISTRY_KEY} dans nos fonctions devient un "unknown variable" que le
; harnais avalerait en avertissement.
!define /ifndef INSTALL_REGISTRY_KEY "Software\${APP_GUID}"
!define /ifndef UNINSTALL_REGISTRY_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"
; Le modele ne declare $installMode et $appExe que dans la passe installeur
; (installer.nsi : Var appExe sous !ifndef BUILD_UNINSTALLER). Les declarer ici
; aussi vaudrait un 6001 "variable jamais utilisee" que -WX rendrait rouge, pour un
; detail qui n'appartient pas a custom.nsh.
Var newStartMenuLink
Var newDesktopLink
Var hasPerMachineInstallation
Var hasPerUserInstallation
Var perMachineInstallationFolder
Var perUserInstallationFolder

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; Les noms doivent etre ceux que electron-builder ecrit, pas ceux qui semblent
; logiques : il traduit "es" en SpanishInternational, et NSIS traite Spanish et
; SpanishInternational comme deux tables distinctes. Inserez "Spanish" ici et un
; LangString absent de la table espagnole passe inapercu -- c'est exactement le
; bug que la production a revele, sous forme d'avertissement 6040 que
; electron-builder transforme en erreur avec -WX.
!macro addLangs
  !insertmacro MUI_LANGUAGE "English"
  !insertmacro MUI_LANGUAGE "French"
  !insertmacro MUI_LANGUAGE "SpanishInternational"
!macroend

!insertmacro addLangs
!insertmacro customHeader

Function un.onInit
  !ifmacrodef customUnInit
    !insertmacro customUnInit
  !endif
FunctionEnd

; NSIS exige au moins une section d'installation, meme dans la passe du
; desinstallateur : le modele la declare vide (Section "install" dont le corps est
; entierement sous !ifndef BUILD_UNINSTALLER). Sans cette ligne, makensis repond
; "invalid script: no sections specified" et l'on croirait a un tort de custom.nsh.
Section "install" 0
SectionEnd

Section "un.install" 1
  !insertmacro customUnInstall
SectionEnd

; En production le desinstallateur est ecrit par la premiere passe (WriteUninstaller
; dans le script installeur), et la seconde ne fait que le relire. Compile tout seul,
; il declenche le 6020 de NSIS - "du code de desinstallation sans WriteUninstaller" -
; que -WX transformerait en echec pour une raison qui n'a rien a voir avec custom.nsh.
Section -WriteUninstaller
  WriteUninstaller "__WORK__/uninstaller-payload.exe"
SectionEnd
NSI

sed -i -e "s|__TEMPLATES__|$templates|g" -e "s|__ROOT__|$root|g" -e "s|__WORK__|$workdir|g" \
  "$workdir/installer.nsi" "$workdir/uninstaller.nsi"

defines=(
  -DPRODUCT_NAME=Soocial
  -DPRODUCT_FILENAME=Soocial
  -DAPP_FILENAME=Soocial
  -DAPP_ID=com.soocial.desktop
  -DAPP_GUID=11111111-1111-1111-1111-111111111111
  -DUNINSTALL_APP_KEY=Soocial
  -DVERSION=1.0.0
  -DSHORTCUT_NAME=Soocial
  -DUNINSTALL_DISPLAY_NAME="Soocial 1.0.0"
  -DCOMPANY_NAME=Soocial
  -DAPP_DESCRIPTION="One window for all your web apps"
  -DPROJECT_DIR="$root"
  -DBUILD_RESOURCES_DIR="$root/installer"
  -DallowToChangeInstallationDirectory=
  -DUNINSTALLER_OUT_FILE="$workdir/uninstaller.exe"
)

status=0

# Politique d'avertissements. electron-builder compile avec -WX : tout avertissement
# casse le build. Le harnais ne reproduit pas tout le modele (il n'inere pas
# uninstaller.nsh, par exemple), donc -WX ici ferait rugir le harnais pour des
# "variable non utilisee" qui n'appartiennent pas a custom.nsh -- et le vrai signal
# se noierait la-dessous. On retient donc les trois familles qui ne peuvent venir
# que de notre script :
#   6000  variable ou constante inconnue (un ${SOO_*} mal orthographie)
#   6010  fonction appelee mais jamais definie
#   6040  un LangString Soocial* absent d'une table de langue (le bug qui n'a
#         ete vu que par le vrai build : "Spanish" n'est pas "SpanishInternational")
for target in installer uninstaller; do
  echo "  makensis : $target"
  extra=()
  [[ "$target" == "uninstaller" ]] && extra=(-DBUILD_UNINSTALLER)
  rc=0
  output=$("$makensis" -V3 "${defines[@]}" "${harness_defines[@]+"${harness_defines[@]}"}" "${extra[@]}" "$workdir/$target.nsi" 2>&1) || rc=$?
  log="$workdir/$target.log"
  printf '%s\n' "$output" > "$log"

  noise='^(Command line defined|Processing config|MakeNSIS v|See the file|Credits can|Note: you may have one or two|Processed [0-9]+ file)'
  problems=$(printf '%s\n' "$output" \
    | grep -vE "$noise" \
    | grep -E '^(Error|warning (6000|6010|6040))|^warning 6001: (Variable "SOO_|Function )' \
    | grep -vE '^warning 60(00|10|40)[^:]*: .*(installer\.nsi|uninstaller\.nsi|common\.nsh)' || true)
  # un 6040 ne cite pas de fichier : il ne nous interesse que s'il parle d'un de nos
  # LangString ; un 6000 qui cite un stub du harnais n'est pas notre faute non plus.
  # Le 6001 (variable ou fonction declaree et jamais utilisee) compte pour NOS
  # noms seulement : c'est lui que le build de production a revele apres le
  # passage des Var sous !ifndef, et -WX en fait une erreur.
  problems=$(printf '%s\n' "$problems" | grep -vE '^$' || true)

  if [[ $rc -ne 0 ]]; then
    status=1
    echo "FAIL  $target (makensis est sorti $rc)"
    printf '%s\n' "$output" | grep -vE "$noise" | tail -30
  elif [[ -n "$problems" ]]; then
    status=1
    echo "FAIL  $target : avertissements qui regardent custom.nsh"
    printf '%s\n' "$problems"
  else
    [[ "${NSI_VERBOSE:-}" == "1" ]] && printf '%s\n' "$output" | grep -E '^warning' | head -10 || true
    echo "OK    $target"
  fi
done

if [[ $status -eq 0 ]]; then
  echo "OK    installer/custom.nsh compile en mode installeur et en mode desinstallateur"
fi
exit $status
