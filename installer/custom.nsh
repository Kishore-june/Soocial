; =============================================================================
;  Soocial - installateur NSIS : chemin d'installation personnalise
; =============================================================================
;
;  COMMENT CE FICHIER EST INCLUS
;  -----------------------------
;  Passe via `nsis.include` dans package.json. electron-builder l'inserre dans
;  l'en-tete generee, AVANT son propre modele (common.nsh, MUI2.nsh,
;  assistedInstaller.nsh), puis inserre la macro `customHeader` juste apres les
;  langues. D'ou deux places distinctes, et l'erreur classique qui consiste a les
;  inverser :
;
;    en tete de fichier : les !define qui reglent les pages. MUI lit le texte de
;                         la page dossier au moment ou assistedInstaller.nsh
;                         l'inserre, donc apres nous : c'est ici qu'il faut peser.
;    dans customHeader  : !define, Var, LangString et Fonctions. LogicLib (${If})
;                         n'existe pas avant MUI2 : une Fonction definie plus tot
;                         ne peut pas l'utiliser, et le message d'erreur de
;                         makensis est particulierement obscur.
;
;  Les macros-crochets appelees par le modele :
;
;    customInit                 dans .onInit, apres initMultiUser. $INSTDIR est
;                               connu s'il vient du registre (update, reinstallation)
;                               ou de /D= (silencie), pas encore du choix fait a la
;                               page dossier en mode interactif.
;    customPageAfterChangeDir   page inserree juste apres MUI_PAGE_DIRECTORY :
;                               premier endroit ou le chemin FINAL est connu, et
;                               dernier endroit ou l'on peut renvoyer l'utilisateur
;                               corriger son choix sans relancer l'installateur.
;                               (electron-builder normalise $INSTDIR dans le "pre"
;                               de la page INSTFILES - voir leur commentaire dans
;                               assistedInstaller.nsh - donc le "leave" de la page
;                               dossier est trop tot pour nous.)
;    customInstall              dans la section, apres la copie des fichiers, des
;                               raccourcis et du registre.
;    customUnInstall            dans la section de desinstallation, AVANT que le
;                               modele ne fasse `RMDir /r $INSTDIR`.
;
;  CE QUE CE FICHIER GARANTIT
;  --------------------------
;  1. L'utilisateur choisit un dossier PARENT ; l'app est posee dans
;     <parent>\Soocial. Jamais dans <parent> seul (la desinstallation n'aurait
;     aucun perimetre et toucherait les voisins), jamais <parent>\Soocial\Soocial.
;  2. Le chemin est valide avant d'ecrire : lecteur present, dossier creable,
;     ecriture reelement possible.
;  3. Une installation existante n'est pas ecrasee sans accord explicite ; en
;     mode silencie, "reinstaller au meme endroit" est l'accord implicite d'un
;     update.
;  4. Registre, install.json et install.ini portent le MEME chemin, ecrit au MEME
;     moment, apres verification.
;  5. Rien ne s'appelle "installe" sans la verification finale : executable,
;     bundle, desinstallateur, metadata. Un echec retire les raccourcis plutot
;     que d'en laisser un qui mene dans le vide.
;  6. Mode silencie (/S, donc la mise a jour automatique) : aucune boite de
;     dialogue. Un MessageBox bloque dans un update silencieux et laisse l'app a
;     moitie remplacee, sans que personne ne puisse cliquer. Les memes regles
;     decident, et le code de sortie le dit.
;  7. Aucune donnee utilisateur dans le dossier d'installation (see
;     main/storage-layout.js) : un deplacement de dossier, une reinstallation, une
;     desinstallation ne doivent pas pouvoir deconnecter six comptes.
;
;  DU COTE DU JS
;  -------------
;  La politique de chemin est ecrite dans shared/path-rules.js, les codes d'erreur
;  dans shared/installer-codes.js. Les valeurs recopiees ici sont comparees
;  automatiquement par test/installer-script.mjs : un installateur et une
;  application qui ne raisonnent pas pareil, c'est exactement le cas ou l'app finit
;  reinstallee sur C: alors que l'utilisateur avait choisi D:.
;
; =============================================================================

!include FileFunc.nsh        ; ${GetDrives}, ${GetTime}

; --- textes des pages, poses avant que MUI2 ne les fige ----------------------
; Le libelle doit enoncer la regle du dossier parent : un utilisateur qui croit
; designer "le dossier de l'application" tape D:\Apps\Soocial et obtient
; D:\Apps\Soocial\Soocial. C'est le seul dechaussage dont il ne se sort pas seul.
!define MUI_DIRECTORYPAGE_TEXT_TOP "$(SoocialDirTop)"
!define MUI_DIRECTORYPAGE_TEXT_DESTINATION "$(SoocialDirDestination)"

/**
 * Textes de l'installateur en anglais. Un macro par langue, appele une fois
 * par index NSIS a nourrir : "Spanish" et "SpanishInternational" sont deux
 * tables differentes, et le meme texte doit les remplir les deux.
 */
!macro SOO_STRINGS_ENGLISH SOO_LANG
  LangString SoocialWelcome        ${SOO_LANG} "Soocial installs into a folder named Soocial, inside the location you choose.$\r$\n$\r$\nDefault:  C:\Program Files\Soocial$\r$\nAdvanced: pick any folder - Soocial creates <that folder>\Soocial$\r$\n$\r$\nYour accounts, settings and downloaded files are never stored in the install folder, so a custom location cannot lose them."
  LangString SoocialDirTop         ${SOO_LANG} "Choose the parent folder - Soocial creates a Soocial folder inside it and installs there.$\r$\n$\r$\nDo not type \Soocial at the end: that would create \Soocial\Soocial."
  LangString SoocialDirDestination ${SOO_LANG} "Soocial will be installed in:"
  LangString SoocialVerify         ${SOO_LANG} "Checking the installed files"
  LangString SoocialDriveMissing   ${SOO_LANG} "The selected drive is not available.$\r$\n$\r$\nConnect the drive, or choose another location.$\r$\n$\r$\nNothing has been changed on the disk."
  LangString SoocialNoPermission   ${SOO_LANG} "Soocial cannot write to this location.$\r$\n$\r$\nChoose another folder, or run the installer with an account allowed to write here.$\r$\n$\r$\nNothing has been changed on the disk."
  LangString SoocialTooLong        ${SOO_LANG} "This path is too long for Windows (260 characters, including the \Soocial folder).$\r$\n$\r$\nChoose a shorter folder."
  LangString SoocialInvalid        ${SOO_LANG} "Windows refuses this folder name: a reserved name (CON, PRN, AUX, NUL, COM1) or a character Windows forbids in a folder name (< > : / \ | ? * and the double quote).$\r$\n$\r$\nChoose another folder."
  LangString SoocialExisting       ${SOO_LANG} "Soocial is already installed here:$\r$\n$\r$\n$INSTDIR$\r$\n$\r$\nInstall here again (accounts and settings are kept), pick another folder, or cancel.$\r$\n$\r$\nAbort = nothing is changed$\r$\nRetry = choose another folder$\r$\nIgnore = reinstall over the existing one"
  LangString SoocialVerifyFailed   ${SOO_LANG} "The installation could not be completed. Shortcuts were removed so that nothing points at an incomplete installation.$\r$\n$\r$\nRun the installer again to repair it."
  LangString SoocialUnsafeUninst   ${SOO_LANG} "This folder does not look like a Soocial installation:$\r$\n$\r$\n$INSTDIR$\r$\n$\r$\nSoocial will remove its shortcuts and registry entries, but will NOT delete any file here. Delete them yourself only if you are sure this folder holds nothing but Soocial."
  LangString SoocialDoneTitle      ${SOO_LANG} "Installation complete"
!macroend

/**
 * Textes de l'installateur en francais. Un macro par langue, appele une fois
 * par index NSIS a nourrir : "Spanish" et "SpanishInternational" sont deux
 * tables differentes, et le meme texte doit les remplir les deux.
 */
!macro SOO_STRINGS_FRENCH SOO_LANG
  LangString SoocialWelcome        ${SOO_LANG} "Soocial s'installe dans un dossier Soocial a l'interieur de l'emplacement que vous choisissez.$\r$\n$\r$\nPar defaut : C:\Program Files\Soocial$\r$\nAvance : choisissez n'importe quel dossier, Soocial cree <ce dossier>\Soocial$\r$\n$\r$\nVos comptes, vos reglages et vos fichiers recus ne sont jamais stocks dans le dossier d'installation : un emplacement personnalise ne peut pas les faire perdre."
  LangString SoocialDirTop         ${SOO_LANG} "Choisissez le dossier parent : Soocial cree un dossier Soocial a l'interieur et l'y installe.$\r$\n$\r$\nN'ajoutez pas \Soocial a la fin, cela creerait \Soocial\Soocial."
  LangString SoocialDirDestination ${SOO_LANG} "Soocial sera installe dans :"
  LangString SoocialVerify         ${SOO_LANG} "Verification des fichiers installes"
  LangString SoocialDriveMissing   ${SOO_LANG} "Le lecteur choisi n'est pas disponible.$\r$\n$\r$\nBranchez le lecteur ou choisissez un autre emplacement.$\r$\n$\r$\nRien n'a ete modifie sur le disque."
  LangString SoocialNoPermission   ${SOO_LANG} "Soocial ne peut pas ecrire a cet endroit.$\r$\n$\r$\nChoisissez un autre dossier, ou lancez l'installateur avec un compte autorise a ecrire ici.$\r$\n$\r$\nRien n'a ete modifie sur le disque."
  LangString SoocialTooLong        ${SOO_LANG} "Ce chemin est trop long pour Windows (260 caracteres, dossier Soocial compris).$\r$\n$\r$\nChoisissez un dossier plus court."
  LangString SoocialInvalid        ${SOO_LANG} "Windows refuse ce nom de dossier : nom reserve (CON, PRN, AUX, NUL, COM1) ou caractere interdit par Windows dans un nom de dossier (< > : / \ | ? * et le guillemet).$\r$\n$\r$\nChoisissez un autre dossier."
  LangString SoocialExisting       ${SOO_LANG} "Soocial est deja installe ici :$\r$\n$\r$\n$INSTDIR$\r$\n$\r$\nReinstaller ici (vos comptes et vos reglages sont conserves), choisir un autre dossier, ou annuler.$\r$\n$\r$\nAnnuler = rien ne change$\r$\nRecommencer = choisir un autre dossier$\r$\nIgnorer = reinstaller par-dessus l'existant"
  LangString SoocialVerifyFailed   ${SOO_LANG} "L'installation n'a pas pu etre terminee. Les raccourcis ont ete retires pour que rien ne pointe vers une installation incomplete.$\r$\n$\r$\nRelancez l'installateur pour reparer."
  LangString SoocialUnsafeUninst   ${SOO_LANG} "Ce dossier ne ressemble pas a une installation Soocial :$\r$\n$\r$\n$INSTDIR$\r$\n$\r$\nSoocial retire ses raccourcis et ses entrees de registre, mais ne supprime AUCUN fichier ici. Ne supprimez les fichiers vous-meme que si ce dossier ne contient que Soocial."
  LangString SoocialDoneTitle      ${SOO_LANG} "Installation terminee"
!macroend

/**
 * Textes de l'installateur en espagnol. Un macro par langue, appele une fois
 * par index NSIS a nourrir : "Spanish" et "SpanishInternational" sont deux
 * tables differentes, et le meme texte doit les remplir les deux.
 */
!macro SOO_STRINGS_SPANISH SOO_LANG
  LangString SoocialWelcome        ${SOO_LANG} "Soocial se instala en una carpeta llamada Soocial dentro de la ubicacion que elija.$\r$\n$\r$\nPredeterminada: C:\Program Files\Soocial$\r$\nAvanzada: elija cualquier carpeta - Soocial crea <esa carpeta>\Soocial.$\r$\n$\r$\nSus cuentas, ajustes y archivos descargados nunca se guardan en la carpeta de instalacion."
  LangString SoocialDirTop         ${SOO_LANG} "Elija la carpeta principal: Soocial crea una carpeta Soocial dentro y la instala alli.$\r$\n$\r$\nNo anada \Soocial al final: crearia \Soocial\Soocial."
  LangString SoocialDirDestination ${SOO_LANG} "Soocial se instalara en:"
  LangString SoocialVerify         ${SOO_LANG} "Comprobando los archivos instalados"
  LangString SoocialDriveMissing   ${SOO_LANG} "La unidad elegida no esta disponible.$\r$\n$\r$\nConecte la unidad o elija otra ubicacion.$\r$\n$\r$\nNo se ha modificado nada en el disco."
  LangString SoocialNoPermission   ${SOO_LANG} "Soocial no puede escribir en esta ubicacion.$\r$\n$\r$\nElija otra carpeta o ejecute el instalador con una cuenta con permisos.$\r$\n$\r$\nNo se ha modificado nada en el disco."
  LangString SoocialTooLong        ${SOO_LANG} "La ruta es demasiado larga para Windows (260 caracteres, incluida la carpeta Soocial).$\r$\n$\r$\nElija una carpeta mas corta."
  LangString SoocialInvalid        ${SOO_LANG} "Windows rechaza este nombre: nombre reservado (CON, PRN, AUX, NUL, COM1) o caracter no permitido en un nombre de carpeta (< > : / \ | ? * y la comilla).$\r$\n$\r$\nElija otra carpeta."
  LangString SoocialExisting       ${SOO_LANG} "Soocial ya esta instalado aqui:$\r$\n$\r$\n$INSTDIR$\r$\n$\r$\nReinstalar aqui (conserva cuentas y ajustes), elegir otra carpeta o cancelar."
  LangString SoocialVerifyFailed   ${SOO_LANG} "La instalacion no pudo completarse. Se eliminaron los accesos directos para que nada apunte a una instalacion incompleta.$\r$\n$\r$\nVuelva a ejecutar el instalador."
  LangString SoocialUnsafeUninst   ${SOO_LANG} "Esta carpeta no parece una instalacion de Soocial:$\r$\n$\r$\n$INSTDIR$\r$\n$\r$\nSoocial quitara sus accesos directos y entradas de registro, pero NO borrara ningun archivo aqui."
  LangString SoocialDoneTitle      ${SOO_LANG} "Instalacion completada"
!macroend

!macro customHeader
  !define SOO_DIR_NAME "Soocial"
  !define SOO_REGISTRY_KEY "Software\Soocial"
  !define SOO_METADATA_JSON "install.json"
  !define SOO_METADATA_INI "install.ini"
  !define SOO_PARTIAL_MARKER ".install-incomplete"
  !define SOO_WRITE_PROBE ".soocial-write-test"
  !define SOO_PATH_MAX 259
  !define SOO_DIR_NAME_LEN 7                    ; longueur de "Soocial"

  ; Codes de sortie. Ils reprennent les codes Win32 quand ils collent a la realite
  ; (5 = ERROR_ACCESS_DENIED, 21 = ERROR_NOT_READY, 123 = ERROR_INVALID_NAME) pour
  ; qu'un `echo %errorlevel%` ou un ticket se lise sans dictionnaire. La table qui
  ; fait autorite est shared/installer-codes.js.
  !define SOO_CODE_OK 0
  !define SOO_CODE_EMPTY 1
  !define SOO_CODE_NO_PERMISSION 5
  !define SOO_CODE_NOT_ABSOLUTE 3
  !define SOO_CODE_DRIVE_UNAVAILABLE 21
  !define SOO_CODE_INVALID_NAME 123
  !define SOO_CODE_TOO_LONG 206
  !define SOO_CODE_VERIFY_FAILED 1604
  !define SOO_CODE_UNSAFE_UNINSTALL 1605
  !define SOO_CODE_USER_ABORT 1602

  ; --- textes multilingues ---------------------------------------------------
  ; Une LangString doit arriver apres les !insertmacro MUI_LANGUAGE : les textes
  ; sont donc ecrits la-haut (au niveau du fichier, une !macro ne peut pas en
  ; contenir une autre) et appeles ici. Les index utilises sont exactement ceux que
  ; electron-builder produit pour `nsis.installerLanguages` de package.json :
  ; en -> English, fr -> French, es -> SpanishInternational.
  ;
  ; Le nom compte. Un !ifdef LANG_SPANISH ne se declenche jamais en production,
  ; puisque "es" devient SpanishInternational : l'installateur afficherait alors
  ; ses propres textes en anglais sans que le build s'en plaigne. Les deux sont
  ; couverts, et test/installer/compile-check.sh insere les MEMES noms avec -WX,
  ; pour qu'un avertissement 6040 ("non defini dans cette table") casse le build.
  !ifdef LANG_ENGLISH
    !insertmacro SOO_STRINGS_ENGLISH ${LANG_ENGLISH}
  !endif
  !ifdef LANG_FRENCH
    !insertmacro SOO_STRINGS_FRENCH ${LANG_FRENCH}
  !endif
  !ifdef LANG_SPANISH
    !insertmacro SOO_STRINGS_SPANISH ${LANG_SPANISH}
  !endif
  !ifdef LANG_SPANISHINTERNATIONAL
    !insertmacro SOO_STRINGS_SPANISH ${LANG_SPANISHINTERNATIONAL}
  !endif

  ; --- etat ------------------------------------------------------------------
  ; Ces neuf Var ne servent qu'a la pose de l'application : elles sont sous
  ; !ifndef BUILD_UNINSTALLER parce que NSIS avertit pour toute variable declaree
  ; et jamais utilisee dans la passe en cours (6001), et que electron-builder
  ; compile avec -WX : un avertissement y est un build casse. Le desinstallateur
  ; n'a pas a porter l'etat de l'installeur.
  !ifndef BUILD_UNINSTALLER
  Var SOO_TARGET              ; <parent>\Soocial, ou <parent> si c'est deja lui
  Var SOO_PARENT              ; ce que l'utilisateur (ou /D=) a designe
  Var SOO_DRIVE               ; "D:" de la cible, '' pour un chemin UNC
  Var SOO_DRIVE_SEEN          ; 1 si le lecteur est dans la table Windows
  Var SOO_PROBLEM             ; code de blocage courant, 0 si rien
  Var SOO_EXISTING            ; 1 si une installation Soocial est deja en place
  Var SOO_INSTALL_ID          ; identifiant derive du chemin, stable sur place
  Var SOO_FIRST_INSTALL       ; date de premiere installation, reprise a chaque update
  Var SOO_ESCAPED             ; sortie de soocialEscapeJson (les $0..$8 sont
                              ; detruits par ${Do}/LogicLib, un registre ne suffit pas)
  ; (le !ifndef ouvert plus haut ferme a la fin de la section installeur)

  ; ===========================================================================
  ;  Fonctions d'installation
  ; ===========================================================================

  ; --- lecteur present ? ----------------------------------------------------
  ; GetDrives appelle la fonction pour chaque lecteur, avec la lettre dans $9
  ; (le macro sauvegarde $0..$8 autour de l'appel, donc on n'ecrit que dans une
  ; Var). Un E:\ deconnecte n'est pas dans la table : c'est l'erreur qu'on veut
  ; produire ici, pas un "acces refuse" trois ecrans plus tard.
  Function soocialDriveSeen
    ${If} $9 == "$SOO_DRIVE\"
      StrCpy $SOO_DRIVE_SEEN 1
    ${EndIf}
  FunctionEnd

  Function soocialDrivePresent
    StrCpy $SOO_DRIVE_SEEN 0
    ${If} $SOO_DRIVE != ""
      ${GetDrives} "ALL" "soocialDriveSeen"
    ${EndIf}
  FunctionEnd

  ; --- ecriture reellement possible -----------------------------------------
  ; Creer puis detruire un fichier temoin. Tester l'attribut "lecture seule" ne
  ; suffit pas : sur un partage, sur un disque plein, ou sur un point de montage
  ; d'un lecteur ejecte, l'attribut dit vrai et l'ecriture echoue quand meme.
  ; $9 est libre ici (FileOpen), le dossier arrive par la pile.
  Function soocialTestWrite
    Exch $R0                       ; $R0 = dossier teste, l'ancien $R0 est sauve
    Push $1
    StrCpy $1 ${SOO_CODE_OK}

    ClearErrors
    FileOpen $9 "$R0\${SOO_WRITE_PROBE}" w
    ${If} ${Errors}
      StrCpy $1 ${SOO_CODE_NO_PERMISSION}
    ${Else}
      FileWrite $9 "soocial"
      FileClose $9
      ClearErrors
      Delete "$R0\${SOO_WRITE_PROBE}"
      ${If} ${Errors}
        ; Notre propre fichier ne part pas : dossier utilisable une fois, hostile
        ; ensuite. Mieux vaut le dire avant 300 Mo de copies.
        StrCpy $1 ${SOO_CODE_NO_PERMISSION}
      ${EndIf}
    ${EndIf}

    ClearErrors
    StrCpy $R0 $1
    Pop $1
    Exch $R0
  FunctionEnd

  ; --- <parent> -> <parent>\Soocial -----------------------------------------
  ; Trois cas, dans cet ordre :
  ;   a) le dossier choisi contient DEJA notre installation (install.ini avec
  ;      product=Soocial, ou Soocial.exe) : c'est le dossier final. Reinstaller
  ;      par-dessus est le comportement attendu d'un update.
  ;   b) le dernier segment s'appelle Soocial : on ne double pas. La comparaison
  ;      est insensible a la casse (StrCmp s'appuie sur lstrcmp), donc comme le
  ;      chemin entier sur Windows.
  ;   c) sinon on ajoute \Soocial.
  ; a) passe avant b) : un dossier "Soocial" sans rapport avec nous (un depot de
  ; photos) ne recoit pas l'application a la racine, il recoit le sous-dossier.
  Function soocialResolveTarget
    ; separateurs et points de fin : "D:\Apps" et "D:\Apps\" doivent designer le
    ; meme endroit. Sinile registre, install.json et les raccourcis portent trois
    ; chaines differentes pour un meme dossier, et la comparaison de l'updater
    ; echoue sur la derniere.
    ${Do}
      StrCpy $0 $INSTDIR 1 -1
      ${If} $0 != "\"
      ${AndIf} $0 != "/"
      ${AndIf} $0 != "."
      ${AndIf} $0 != " "
        ${ExitDo}
      ${EndIf}
      StrCpy $INSTDIR $INSTDIR -1
      ${If} $INSTDIR == ""
        ${ExitDo}
      ${EndIf}
    ${Loop}

    StrCpy $SOO_PARENT $INSTDIR
    StrCpy $SOO_EXISTING 0

    ; a) notre installation deja ici ?
    ClearErrors
    ReadINIStr $0 "$INSTDIR\${SOO_METADATA_INI}" "soocial" "product"
    ${Unless} ${Errors}
      ${If} $0 == "Soocial"
        StrCpy $SOO_TARGET $INSTDIR
        StrCpy $SOO_EXISTING 1
        Goto soocialResolveDone
      ${EndIf}
    ${EndUnless}
    ClearErrors

    ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      ${If} ${FileExists} "$INSTDIR\${SOO_METADATA_JSON}"
        StrCpy $SOO_TARGET $INSTDIR
        StrCpy $SOO_EXISTING 1
        Goto soocialResolveDone
      ${EndIf}
    ${EndIf}

    ; b) le dossier s'appelle deja Soocial ?
    StrCpy $0 "$INSTDIR" ${SOO_DIR_NAME_LEN} -${SOO_DIR_NAME_LEN}
    StrCmp $0 "${SOO_DIR_NAME}" 0 soocialAppend

    StrCpy $SOO_TARGET $INSTDIR
    ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      StrCpy $SOO_EXISTING 1
    ${EndIf}
    Goto soocialResolveDone

    ; c) le sous-dossier attendu
    soocialAppend:
      StrCpy $SOO_TARGET "$INSTDIR\${SOO_DIR_NAME}"
      ${If} ${FileExists} "$SOO_TARGET\${APP_EXECUTABLE_FILENAME}"
        StrCpy $SOO_EXISTING 1
      ${EndIf}

    soocialResolveDone:
      ; Lecteur : "X:" en tete, sinon rien (un chemin \\serveur\partage n'a pas de
      ; lecteur a tester, on laisse l'ecriture repondre).
      StrCpy $0 "$SOO_TARGET" 2
      ${If} $0 == "\\"
        StrCpy $SOO_DRIVE ""
      ${Else}
        StrCpy $SOO_DRIVE "$SOO_TARGET" 2
      ${EndIf}
  FunctionEnd

  ; --- validation complete ---------------------------------------------------
  ; Remplit $SOO_PROBLEM (0 = on peut installer). Le chemin est mesure ici et pas
  ; ailleurs : c'est le seul moment ou le chemin FINAL (avec \Soocial) est connu,
  ; donc le seul ou la longueur ait un sens.
  Function soocialValidate
    StrCpy $SOO_PROBLEM ${SOO_CODE_OK}

    ${If} $SOO_TARGET == ""
      StrCpy $SOO_PROBLEM ${SOO_CODE_EMPTY}
      Return
    ${EndIf}

    ; absolu : "X:" en position 2, ou \\serveur\partage
    StrCpy $0 "$SOO_TARGET" 1 1
    ${If} $0 != ":"
      StrCpy $1 "$SOO_TARGET" 2
      ${If} $1 != "\\"
        StrCpy $SOO_PROBLEM ${SOO_CODE_NOT_ABSOLUTE}
        Return
      ${EndIf}
    ${EndIf}

    ; longueur (MAX_PATH = 260, mesure avec notre sous-dossier)
    StrLen $0 "$SOO_TARGET"
    ${If} $0 > ${SOO_PATH_MAX}
      StrCpy $SOO_PROBLEM ${SOO_CODE_TOO_LONG}
      Return
    ${EndIf}

    Call soocialDrivePresent
    ${If} $SOO_DRIVE != ""
    ${AndIf} $SOO_DRIVE_SEEN != 1
      StrCpy $SOO_PROBLEM ${SOO_CODE_DRIVE_UNAVAILABLE}
      Return
    ${EndIf}

    ; creation si necessaire. C'est l'etape que le cahier des charges demande
    ; ("le dossier n'existe pas : le creer ?") ; on la fait ici, une fois, pour
    ; que le test d'ecriture porte sur le dossier final. CreateDirectory echoue
    ; aussi sur les noms reserves et les caracteres interdits, et c'est tant
    ; mieux : la liste des noms reserves depend de la locale et du systeme de
    ; fichiers, Windows la connait mieux que n'importe quelle table.
    ${IfNot} ${FileExists} "$SOO_TARGET\*.*"
      ClearErrors
      CreateDirectory "$SOO_TARGET"
      ${If} ${Errors}
        System::Call 'kernel32::GetLastError() i.r0'
        DetailPrint "Soocial: CreateDirectory echoue (code Windows $0)"
        ${If} $0 == 5
          StrCpy $SOO_PROBLEM ${SOO_CODE_NO_PERMISSION}
        ${ElseIf} $0 == 21
          StrCpy $SOO_PROBLEM ${SOO_CODE_DRIVE_UNAVAILABLE}
        ${Else}
          StrCpy $SOO_PROBLEM ${SOO_CODE_INVALID_NAME}
        ${EndIf}
        ClearErrors
        Return
      ${EndIf}
    ${EndIf}

    Push $SOO_TARGET
    Call soocialTestWrite
    Pop $0
    ${If} $0 != ${SOO_CODE_OK}
      StrCpy $SOO_PROBLEM $0
    ${EndIf}
  FunctionEnd

  ; Preparation commune aux deux modes : resoudre puis valider.
  Function soocialPrepare
    Call soocialResolveTarget
    Call soocialValidate
  FunctionEnd

  ; --- message d'echec, selon le code ---------------------------------------
  ; En mode silencieux on ne passe jamais ici : le code part dans errorlevel.
  Function soocialMessageFor
    Exch $0
    ${If} $0 == ${SOO_CODE_DRIVE_UNAVAILABLE}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(SoocialDriveMissing)$\r$\n$\r$\n$SOO_TARGET" /SD IDCANCEL IDRETRY +2
      Abort
    ${ElseIf} $0 == ${SOO_CODE_NO_PERMISSION}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(SoocialNoPermission)$\r$\n$\r$\n$SOO_TARGET" /SD IDCANCEL IDRETRY +2
      Abort
    ${ElseIf} $0 == ${SOO_CODE_TOO_LONG}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(SoocialTooLong)$\r$\n$\r$\n$SOO_TARGET" /SD IDCANCEL IDRETRY +2
      Abort
    ${Else}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(SoocialInvalid)$\r$\n$\r$\n$SOO_TARGET" /SD IDCANCEL IDRETRY +2
      Abort
    ${EndIf}
    Pop $0
  FunctionEnd

  ; --- page de confirmation --------------------------------------------------
  ; Une page sans champ : elle montre le chemin FINAL et bloque le passage si la
  ; validation echoue. `Abort` dans la fonction "show" renvoie a la page
  ; precedente, c'est-a-dire au choix du dossier.
  Function soocialConfirmPage
    ${If} ${Silent}
      Return                       ; le silencieux est traite dans customInit
    ${EndIf}

    Call soocialPrepare

    ${If} $SOO_PROBLEM != ${SOO_CODE_OK}
      Push $SOO_PROBLEM
      Call soocialMessageFor
      Return
    ${EndIf}

    ${If} $SOO_EXISTING == 1
      MessageBox MB_ABORTRETRYIGNORE|MB_ICONINFORMATION "$(SoocialExisting)" /SD IDIGNORE IDABORT soocialExistingAbort IDRETRY soocialExistingRetry
      Goto soocialExistingGo
      soocialExistingAbort:
        Quit
      soocialExistingRetry:
        Abort
      soocialExistingGo:
    ${EndIf}

    StrCpy $INSTDIR $SOO_TARGET
    Return
  FunctionEnd

  ; --- metadata d'installation -----------------------------------------------
  ; install.json pour l'app et pour la mise a jour ; install.ini pour NSIS et pour
  ; le desinstallateur, qui ne savent pas parser du JSON. Meme contenu, memes
  ; valeurs, memes instant : un ecart entre les deux est exactement le bug ou
  ; l'updater tape au mauvais endroit.
  Function soocialWriteMetadata
    ; Date avant tout le reste : GetTime ecrase $0..$6.
    ${GetTime} "" "L" $R1 $R2 $R3 $R4 $R5 $R6 $R7   ; annee, jour, mois, h, min, s, jour-de-la-semaine
    IntFmt $R3 "%02d" $R3
    IntFmt $R2 "%02d" $R2
    StrCpy $8 "$R1-$R3-$R2"

    ${If} ${FileExists} "$INSTDIR\${SOO_METADATA_INI}"
      ClearErrors
      ReadINIStr $0 "$INSTDIR\${SOO_METADATA_INI}" "soocial" "firstInstall"
      ${Unless} ${Errors}
        ${If} $0 != ""
          StrCpy $8 $0
        ${EndIf}
      ${EndUnless}
      ClearErrors
      ReadINIStr $0 "$INSTDIR\${SOO_METADATA_INI}" "soocial" "installationId"
      ${Unless} ${Errors}
        ${If} $0 != ""
          StrCpy $SOO_INSTALL_ID $0
        ${EndIf}
      ${EndUnless}
    ${EndIf}
    ClearErrors

    StrCpy $SOO_FIRST_INSTALL $8
    ${If} $SOO_INSTALL_ID == ""
      ; Identifiant derive du chemin : un GUID genere a chaque installation
      ; changerait a chaque update. L'interet est justement de retrouver la MEME
      ; installation d'un update a l'autre, quel que soit le disque.
      StrCpy $SOO_INSTALL_ID "$INSTDIR"
    ${EndIf}

    ; --- install.ini (lu par NSIS) ---
    WriteINIStr "$INSTDIR\${SOO_METADATA_INI}" "soocial" "product" "Soocial"
    WriteINIStr "$INSTDIR\${SOO_METADATA_INI}" "soocial" "schemaVersion" "1"
    WriteINIStr "$INSTDIR\${SOO_METADATA_INI}" "soocial" "path" "$INSTDIR"
    WriteINIStr "$INSTDIR\${SOO_METADATA_INI}" "soocial" "version" "${VERSION}"
    WriteINIStr "$INSTDIR\${SOO_METADATA_INI}" "soocial" "scope" "$installMode"
    WriteINIStr "$INSTDIR\${SOO_METADATA_INI}" "soocial" "installationId" "$SOO_INSTALL_ID"
    WriteINIStr "$INSTDIR\${SOO_METADATA_INI}" "soocial" "firstInstall" "$SOO_FIRST_INSTALL"
    WriteINIStr "$INSTDIR\${SOO_METADATA_INI}" "soocial" "appData" "$APPDATA\${APP_FILENAME}"

    ; --- install.json (lu par l'app) ---
    Push $INSTDIR
    Call soocialEscapeJson
    Pop $0                             ; $0 == $SOO_ESCAPED, par lisibilite du site
    StrCpy $0 "$SOO_ESCAPED"

    ClearErrors
    FileOpen $1 "$INSTDIR\${SOO_METADATA_JSON}" w
    ${If} ${Errors}
      DetailPrint "Soocial: install.json n'a pas pu etre ecrit dans $INSTDIR"
    ${Else}
      ${If} ${FileExists} "$newDesktopLink"
        StrCpy $2 "true"
      ${Else}
        StrCpy $2 "false"
      ${EndIf}
      FileWrite $1 '{$\r$\n'
      FileWrite $1 '  "schemaVersion": 1,$\r$\n'
      FileWrite $1 '  "product": "Soocial",$\r$\n'
      FileWrite $1 '  "installPath": "$0",$\r$\n'
      FileWrite $1 '  "version": "${VERSION}",$\r$\n'
      FileWrite $1 '  "channel": "stable",$\r$\n'
      FileWrite $1 '  "architecture": "x64",$\r$\n'
      FileWrite $1 '  "installationId": "$SOO_INSTALL_ID",$\r$\n'
      FileWrite $1 '  "firstInstall": "$SOO_FIRST_INSTALL",$\r$\n'
      FileWrite $1 '  "dataRoot": "$APPDATA\${APP_FILENAME}",$\r$\n'
      FileWrite $1 '  "installer": {$\r$\n'
      FileWrite $1 '    "engine": "nsis",$\r$\n'
      FileWrite $1 '    "appId": "${APP_ID}",$\r$\n'
      FileWrite $1 '    "productFilename": "${PRODUCT_FILENAME}",$\r$\n'
      FileWrite $1 '    "scope": "$installMode",$\r$\n'
      FileWrite $1 '    "shortcutName": "${SHORTCUT_NAME}"$\r$\n'
      FileWrite $1 '  },$\r$\n'
      FileWrite $1 '  "shortcuts": {$\r$\n'
      FileWrite $1 '    "desktop": $2,$\r$\n'
      ${If} ${FileExists} "$newStartMenuLink"
        StrCpy $2 "true"
      ${Else}
        StrCpy $2 "false"
      ${EndIf}
      FileWrite $1 '    "startMenu": $2,$\r$\n'
      Push "$newDesktopLink"
      Call soocialEscapeJson
      FileWrite $1 '    "desktopLink": "$SOO_ESCAPED",$\r$\n'
      Push "$newStartMenuLink"
      Call soocialEscapeJson
      FileWrite $1 '    "startMenuLink": "$SOO_ESCAPED"$\r$\n'
      FileWrite $1 '  }$\r$\n'
      FileWrite $1 '}$\r$\n'
      FileClose $1
    ${EndIf}

    ; --- registre lisible par un humain ---------------------------------------
    ; ${INSTALL_REGISTRY_KEY} (cle GUID) est deja ecrite par le modele : c'est la
    ; que Windows et l'updater regardent. Celle-ci est le double lisible, celui
    ; qu'on cite dans un ticket, avec le chemin en clair.
    WriteRegStr SHELL_CONTEXT "${SOO_REGISTRY_KEY}" "InstallPath" "$INSTDIR"
    WriteRegStr SHELL_CONTEXT "${SOO_REGISTRY_KEY}" "Version" "${VERSION}"
    WriteRegStr SHELL_CONTEXT "${SOO_REGISTRY_KEY}" "InstallationId" "$SOO_INSTALL_ID"
    WriteRegStr SHELL_CONTEXT "${SOO_REGISTRY_KEY}" "FirstInstall" "$SOO_FIRST_INSTALL"
    WriteRegStr SHELL_CONTEXT "${SOO_REGISTRY_KEY}" "Exe" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    WriteRegStr SHELL_CONTEXT "${SOO_REGISTRY_KEY}" "AppData" "$APPDATA\${APP_FILENAME}"
  FunctionEnd

  ; Echappe les anti-slashes pour du JSON (D:\Apps devient D:\\Apps). Les espaces,
  ; les caracteres accentues et les ideogrammes passent tels quels : NSIS est en
  ; Unicode, le fichier est ecrit en UTF-8, et l'app le relit sans transcodage.
  ;
  ; Deux pieges, regles une fois pour toutes :
  ;   - le separateur ne s'ecrit PAS "\" (deux anti-slashes dans une chaine
  ;     doublement quotee : NSIS ne desechappe que les guillemets), il s'ecrit '\'
  ;     entre apostrophes ;
  ;   - le resultat ne peut pas voyager par $R0 autour d'un ${Do} : LogicLib et
  ;     les macros de FileFunc sauvent et restituent $0..$8, et effacent donc ce
  ;     qu'on y a ecrit. D'ou $SOO_ESCAPED, une Var, pas un registre.
  Function soocialEscapeJson
    Exch $R0
    Push $1
    Push $2
    Push $3
    Push $4
    StrCpy $4 '\'                       ; un seul anti-slash, litteral
    StrCpy $3 ""
    StrCpy $1 0

    ${Do}
      StrCpy $2 $R0 1 $1
      ${If} $2 == ""
        ${ExitDo}
      ${EndIf}
      ${If} $2 == $4
        StrCpy $3 "$3\\"                 ; double : "\\" = deux anti-slashes
      ${Else}
        StrCpy $3 "$3$2"
      ${EndIf}
      IntOp $1 $1 + 1
    ${Loop}

    StrCpy $SOO_ESCAPED $3
    StrCpy $R0 $3                      ; la pile rend la meme chose que la Var
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Exch $R0
  FunctionEnd

  ; --- verification finale ---------------------------------------------------
  ; Laisse sur la pile le nom du fichier manquant, '' si tout est la.
  Function soocialVerify
    Push $0
    StrCpy $0 ""

    ${IfNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      StrCpy $0 "${APP_EXECUTABLE_FILENAME}"
    ${ElseIfNot} ${FileExists} "$INSTDIR\resources\app.asar"
      StrCpy $0 "resources\app.asar"
    ${ElseIfNot} ${FileExists} "$INSTDIR\${UNINSTALL_FILENAME}"
      StrCpy $0 "${UNINSTALL_FILENAME}"
    ${ElseIfNot} ${FileExists} "$INSTDIR\${SOO_METADATA_JSON}"
      StrCpy $0 "${SOO_METADATA_JSON}"
    ${EndIf}

    Pop $0
    Exch $0
  FunctionEnd
!endif
!macroend

; =============================================================================
;  Macros-crochets
; =============================================================================

; -----------------------------------------------------------------------------
;  customInit : en mode silencieux, c'est ici que le chemin est connu (/D=..., ou
;  le registre d'une installation existante). Un chemin refuse doit faire echouer
;  l'installation tot, avec un code de sortie, surtout pas la deplacer ailleurs :
;  "silencieusement reinstalle sur C:" est le defaut qu'on ne pardonne pas.
; -----------------------------------------------------------------------------
!macro customInit
!ifndef BUILD_UNINSTALLER
  ; Journal de diagnostic. Un rapport du type "mon dossier est refuse" ne se
  ; rejoue pas sur la machine du client : poser un fichier vide nomme SOO_DEBUG a
  ; cote de Setup.exe active le log NSIS (DetailPrint + tout ce que le modele
  ; imprime) a cote de l'installeur. Sans ce fichier, rien n'est ecrit et aucune
  ; ligne de plus n'est executee.
  ClearErrors
  FileOpen $9 "$EXEDIR\SOO_DEBUG" r
  ${Unless} ${Errors}
    FileClose $9
    # NSIS 3 n'a plus de LogFile : en mode silencieux, LogSet ecrit sur la sortie
    # standard, que `Setup.exe /S > journal.txt` capture. C'est ce que fait le test
    # d'installation sous wine, et ce que l'on demande dans un rapport distant.
    ; LogSet on
    DetailPrint "Soocial: journal de diagnostic active ($EXEDIR)"
  ${EndUnless}
  ClearErrors

  ${If} ${Silent}
    Call soocialPrepare
    ${If} $SOO_PROBLEM != ${SOO_CODE_OK}
      DetailPrint "Soocial: emplacement refuse (code $SOO_PROBLEM)"
      SetErrorLevel $SOO_PROBLEM
      Quit
    ${EndIf}
    StrCpy $INSTDIR $SOO_TARGET
    CreateDirectory "$SOO_TARGET"
  ${EndIf}
!endif
!macroend

; -----------------------------------------------------------------------------
;  customPageAfterChangeDir : confirmation du chemin en mode interactif.
; -----------------------------------------------------------------------------
!macro customPageAfterChangeDir
!ifndef BUILD_UNINSTALLER
  Page custom soocialConfirmPage
!endif
!macroend

; -----------------------------------------------------------------------------
;  customInstall : apres la copie des fichiers et la pose des raccourcis.
;  Ordre : marqueur d'inacheve, re-resolution (le dossier a pu etre renomme entre
;  la page et ici), metadata, verification, retrait du marqueur. "Installe" n'est
;  jamais dit sans la verification.
; -----------------------------------------------------------------------------
!macro customInstall
!ifndef BUILD_UNINSTALLER
  ClearErrors
  FileOpen $9 "$INSTDIR\${SOO_PARTIAL_MARKER}" w
  ${Unless} ${Errors}
    FileWrite $9 "${VERSION}"
    FileClose $9
  ${EndUnless}
  ClearErrors

  Call soocialResolveTarget
  ${If} $SOO_TARGET != ""
    StrCpy $INSTDIR $SOO_TARGET
  ${EndIf}

  Call soocialWriteMetadata

  Call soocialVerify
  Pop $0
  ${If} $0 != ""
    DetailPrint "Soocial: verification echouee, fichier manquant : $0"

    ; Un raccourci qui mene a une installation incomplete est pire que pas de
    ; raccourci : l'utilisateur ne peut pas deviner laquelle des copies il lance.
    ${If} ${FileExists} "$newStartMenuLink"
      Delete "$newStartMenuLink"
    ${EndIf}
    ${If} ${FileExists} "$newDesktopLink"
      Delete "$newDesktopLink"
    ${EndIf}

    ${If} $SOO_EXISTING == 0
      ; Dossier cree par nous et installation non complete : on le rend vide.
      ; Jamais $SOO_PARENT : la, c'est le dossier de l'utilisateur.
      RMDir /r "$INSTDIR"
    ${EndIf}

    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "$(SoocialVerifyFailed)"
    ${EndIf}
    SetErrorLevel ${SOO_CODE_VERIFY_FAILED}
    Abort
  ${EndIf}

  ; Le marqueur ne part que si la verification a passe : c'est lui qui permet a la
  ; tentative suivante de savoir si elle repart de zero.
  Delete "$INSTDIR\${SOO_PARTIAL_MARKER}"
  DetailPrint "$(SoocialDoneTitle): $INSTDIR"
!endif
!macroend

; -----------------------------------------------------------------------------
;  customUnInstall : recadrage de $INSTDIR AVANT que le modele ne supprime.
;
;  Le modele fait `RMDir /r $INSTDIR`. Si la cle de registre a mente (dossier
;  deplace a la main, cle laissee par une version plus ancienne, chemin recopie
;  d'une machine a l'autre), $INSTDIR designe le dossier choisi par l'utilisateur,
;  avec Photoshop a cote. Cette garde existe pour que "desinstaller Soocial" ne
;  puisse jamais devenir "vider D:\Apps".
; -----------------------------------------------------------------------------
; -----------------------------------------------------------------------------
;  customUnInit : le chemin, avant meme la premiere page du desinstallateur.
;
;  Le modele a lu $INSTDIR dans le registre. Si le dossier a ete deplace a la
;  main (ou si la cle a ete recopiee d'une autre machine), cette valeur est
;  fausse, et deux choses suivraient : la page de confirmation afficherait un
;  chemin qui n'existe pas, et la section irait vider un dossier qui n'est pas
;  a nous. Le retablir ici - et pas dans la section - laisse aussi le controle
;  d'existence s'exprimer avant que l'utilisateur ait clique.
;
;  C'est le seul endroit ou notre install.ini est plus credible que le registre :
;  il est ecrit a cote de l'executable, donc il bouge avec lui.
; -----------------------------------------------------------------------------
!macro customUnInit
!ifdef BUILD_UNINSTALLER
  ClearErrors
  ReadINIStr $0 "$INSTDIR\${SOO_METADATA_INI}" "soocial" "path"
  ${Unless} ${Errors}
    ${If} $0 != ""
    ${AndIf} ${FileExists} "$0\${APP_EXECUTABLE_FILENAME}"
      StrCpy $INSTDIR $0
    ${EndIf}
  ${EndUnless}
  ClearErrors

  ; Le registre ${INSTALL_REGISTRY_KEY} porte InstallLocation : s'il est la et que
  ; l'executable y est, c'est lui qui decide (il est ecrite par le modele a chaque
  ; installation, notre ini n'a pas de raison d'etre plus juste).
  ReadRegStr $1 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $1 != ""
  ${AndIf} ${FileExists} "$1\${APP_EXECUTABLE_FILENAME}"
    StrCpy $INSTDIR $1
  ${EndIf}
!endif
!macroend

!macro customUnInstall
!ifdef BUILD_UNINSTALLER
  ; 1. garde : un dossier qui ne s'appelle pas Soocial et qui ne contient ni notre
  ;    executable ni notre metadata ne sera pas vide. On retire nos raccourcis,
  ;    nos cles, et on s'arrete la. Le modele ne verra qu'un $INSTDIR vide.
  StrCpy $1 "$INSTDIR" ${SOO_DIR_NAME_LEN} -${SOO_DIR_NAME_LEN}
  ${If} $1 == "${SOO_DIR_NAME}"
    Goto soocialUnTrusted
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    Goto soocialUnTrusted
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\${SOO_METADATA_INI}"
    Goto soocialUnTrusted
  ${EndIf}

  ${IfNot} ${Silent}
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(SoocialUnsafeUninst)" /SD IDOK IDOK +2
    Quit
  ${Else}
    SetErrorLevel ${SOO_CODE_UNSAFE_UNINSTALL}
  ${EndIf}
  StrCpy $INSTDIR "$PLUGINSDIR\soocial-empty"
  Goto soocialUnEnd

  soocialUnTrusted:
    Delete "$INSTDIR\${SOO_METADATA_JSON}"
    Delete "$INSTDIR\${SOO_METADATA_INI}"
    Delete "$INSTDIR\${SOO_PARTIAL_MARKER}"
    ; Le desinstallateur lui-meme part avec le reste (le modele le deplace, puis
    ; le supprime : rien a faire ici).

  soocialUnEnd:
    DeleteRegValue SHELL_CONTEXT "${SOO_REGISTRY_KEY}" "InstallPath"
    DeleteRegValue SHELL_CONTEXT "${SOO_REGISTRY_KEY}" "Version"
    DeleteRegValue SHELL_CONTEXT "${SOO_REGISTRY_KEY}" "InstallationId"
    DeleteRegValue SHELL_CONTEXT "${SOO_REGISTRY_KEY}" "FirstInstall"
    DeleteRegValue SHELL_CONTEXT "${SOO_REGISTRY_KEY}" "Exe"
    DeleteRegValue SHELL_CONTEXT "${SOO_REGISTRY_KEY}" "AppData"
    ; La cle ne doit pas survivre vide : une cle vivante fait croire a une
    ; installation presente, et l'installateur suivant propose alors de reparer une
    ; application qui n'existe plus.
    DeleteRegKey SHELL_CONTEXT "${SOO_REGISTRY_KEY}"
!endif
!macroend
