# Publication sur le Microsoft Store

Soocial part sur le Store en MSIX, et pas avec l'installeur EXE : Microsoft
resigne les paquets MSIX apres certification, donc aucun certificat a acheter.
Un EXE, lui, doit arriver deja signe par une autorite reconnue — quelques
centaines d'euros par an, avec jeton materiel.

Les deux canaux coexistent et ne se croisent jamais :

| Canal | Commande | Artefact | Mise a jour |
|---|---|---|---|
| GitHub Releases | `npm run release` | `Soocial-Setup-<version>.exe` | electron-updater |
| Microsoft Store | `npm run build:store` | `Soocial-<version>-store.msix` | le Store |

`npm run build:store` passe `appx` en cible sur la ligne de commande, ce qui
prime sur `win.target`, et `--publish never` pour qu'aucun artefact Store ne
parte vers GitHub. La cible `nsis` n'est pas touchee.

Il passe aussi `--config electron-builder.store.js`. Ce fichier reprend la
configuration de `package.json` — qui reste la source unique — et y ajoute la
seule difference d'empaquetage : l'exclusion d'`electron-updater`, inutile dans
un paquet Store. `files` ne se configurant pas par cible, et l'ecraser en ligne
de commande (`-c.files.7=...`) produisant un objet la ou le schema attend un
tableau, `--config` est la voie propre.

## Versions

`package.json` garde un semver a trois nombres. electron-builder en derive la
version a quatre du manifeste en ajoutant la revision : `1.0.1` donne
`1.0.1.0`. **Le Store exige cette revision a zero**, d'ou `setBuildNumber:
false` — l'activer y mettrait un numero de build et ferait rejeter le paquet.
Ne jamais ecrire une version a quatre nombres a la main.

## Identite du paquet

Relevee dans Partner Center (Product management > Product identity) et recopiee
dans `build.appx` de `package.json`. Ces valeurs ne s'inventent pas et ne se
modifient plus une fois le produit publie.

| Champ | Valeur |
|---|---|
| `Package/Identity/Name` | `MehdiJoyen.SoocialDesktop` |
| `Package/Identity/Publisher` | `CN=3AEA6691-12A7-4EC5-B304-754AC77D0730` |
| `Package/Properties/PublisherDisplayName` | `Mehdi Joyen` |
| Package Family Name | `MehdiJoyen.SoocialDesktop_6sysvkg83wmrg` |
| Store ID | `9PBW3G2B60J6` |

## Ce que le paquet change dans le code

Tout passe par un seul drapeau, `isStore` dans `main.js`, qui lit
`process.windowsStore` : Electron le leve quand le process tourne depuis un
paquet MSIX. Rien n'est decide au build, le meme code sert aux deux canaux.

### Notifications — l'identite Windows

Un paquet MSIX impose son AUMID, `<PackageFamilyName>!<ApplicationId>`, soit
`MehdiJoyen.SoocialDesktop_6sysvkg83wmrg!Soocial`. `app.setAppUserModelId()` n'est
donc plus appele dans le paquet : la valeur historique `com.mehdi.soocial` ferait
emettre les toasts sous une identite que Windows n'associe a aucun paquet
installe. Ils cesseraient de s'afficher, sans erreur, sans trace dans les logs.

C'est la fonction phare du produit : c'est le premier test a faire.

### Mises a jour — electron-updater desactive

Le Store distribue les mises a jour, et une application empaquetee ne peut pas
reecrire son propre paquet : le dossier d'installation est en lecture seule.
Dans le paquet, `require('electron-updater')` n'a jamais lieu, l'entree de menu
« Rechercher des mises a jour » devient « Voir dans le Microsoft Store », et ni
la pastille de la sidebar ni l'entree du tray n'apparaissent — elles dependent
de `pendingUpdate`, qui reste nul.

### Lancement au demarrage — StartupTask

`app.setLoginItemSettings()` ecrit sous `HKCU\...\Run`. Ce registre est
virtualise vers le conteneur du paquet, que Windows ne lit pas a l'ouverture de
session : l'appel reussit, le reglage est memorise, et rien ne demarre jamais.

C'est l'extension `windows.startupTask` de `installer/appx-extensions.xml` qui
fait foi. Elle est declaree `Enabled="false"` : l'activer par programme demande
l'API WinRT `StartupTask`, hors de portee d'Electron sans module natif. Le menu
Fichier ouvre donc directement Parametres > Applications > Demarrage.

**Ecart fonctionnel assume** : l'option « demarrer masque dans la zone de
notification » n'existe pas dans le paquet Store. Une entree StartupTask lance
l'executable sans argument, donc `--hidden` n'arrive jamais, et rien ne permet
de distinguer un lancement a l'ouverture de session d'un lancement manuel.
Honorer le reglage dans tous les cas masquerait aussi la fenetre quand
l'utilisateur ouvre Soocial depuis le menu Demarrer.

### Donnees — pas de virtualisation, et profil partage

Aucune ecriture hors du dossier de donnees : `electron-store` pour la config,
`catalog-icons.json` pour le cache d'icones, et les partitions `persist:<id>`
qui portent les sessions isolees. Tout vit sous `app.getPath('userData')`.

**Mesure faite sur le paquet installe** : `%APPDATA%` n'est pas redirige. Depuis
Windows 10 1903, les paquets `runFullTrust` ecrivent dans le vrai
`%APPDATA%\Soocial`, pas dans `LocalCache\Roaming` du conteneur — ce dernier reste
vide. Deux consequences, opposees :

- **La migration depuis l'EXE est automatique et totale.** La version Store
  ouvre le profil existant tel quel : services, ordre, sessions connectees. Rien
  a ecrire pour la prendre en charge.
- **Les deux versions partagent un seul profil.** Elles ne doivent donc jamais
  tourner en meme temps : deux instances Electron sur les memes bases LevelDB
  et les memes partitions de session, c'est de la corruption de donnees.

### Coexistence avec la version EXE

Le verrou de `app.requestSingleInstanceLock()` derive du chemin de `userData`,
identique pour les deux versions. Si la version NSIS tourne — son etat normal,
elle reside dans la zone de notification — le lancement du paquet Store ne
demarre rien : il reveille la fenetre de l'autre et s'arrete. Aucune erreur,
aucun log, l'utilisateur croit le paquet casse.

Ce comportement protege les donnees, et il ne se contourne pas proprement :
l'instance qui arrive ne peut pas savoir quelle version detient le verrou, et
afficher un avertissement a chaque echec casserait le cas normal ou l'on relance
l'app deja ouverte pour la remettre au premier plan.

**La regle est donc de ne pas les faire coexister** : desinstaller la version
EXE en passant au Store. Le profil etant partage, la bascule est transparente.
A rappeler dans la description de la fiche Store.

## Test local (sideload)

Le paquet produit n'est pas signe, et c'est voulu : le Store resigne apres
certification. Mais Windows refuse d'installer un MSIX non signe, d'ou un
certificat auto-signe pour le test seul.

```powershell
npm run build:store
.\installer\sideload-msix.ps1        # emet le certificat et signe une copie
```

Le script signe `Soocial-<version>-sideload.msix` et laisse
`Soocial-<version>-store.msix` intact : c'est ce dernier qu'on televerse.

Les deux dernieres etapes demandent une console **administrateur** :

```powershell
Import-Certificate -FilePath .\dist\soocial-sideload.cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople
Add-AppxPackage -Path .\dist\Soocial-1.0.0-sideload.msix
```

C'est bien le `.cer` qu'on importe, jamais le `.pfx` : faire confiance a une
signature ne demande que la partie publique. Le `.pfx` porte la cle privee et
ne sert qu'a signer.

Le sujet du certificat doit correspondre au caractere pres au `Publisher` du
manifeste. Sinon l'installation echoue sur `0x800B0109`, un message qui ne
nomme jamais la vraie cause.

Pour desinstaller :

```powershell
Get-AppxPackage -Name MehdiJoyen.SoocialDesktop | Remove-AppxPackage
```

## A verifier avant de soumettre

Dans cet ordre — les deux premiers sont ceux qui cassent silencieusement.

1. **Notifications.** Ouvrir un service, declencher un message entrant. Le toast
   doit s'afficher et porter « Soocial Messenger ». Verifier que l'AUMID vu par
   Windows est bien `MehdiJoyen.SoocialDesktop_6sysvkg83wmrg!Soocial` :
   `(Get-AppxPackage -Name MehdiJoyen.SoocialDesktop).PackageFamilyName`
2. **Sessions isolees.** Se connecter a deux comptes du meme service, fermer
   l'app, **redemarrer la machine**, rouvrir : les deux sessions doivent etre
   encore ouvertes et toujours distinctes. C'est le coeur du produit et le point
   que la virtualisation du systeme de fichiers peut casser.
3. **Lancement au demarrage.** Parametres > Applications > Demarrage : « Soocial »
   doit apparaitre. L'activer, redemarrer, verifier que Soocial se lance.
4. **Zone de notification.** Icone presente, fermeture de la fenetre qui replie
   dans le tray, menu contextuel operationnel.
5. **Migration depuis la version EXE.** Verifiee sur Windows 11 26100 : le
   paquet reprend le profil existant sans rien faire, `%APPDATA%` n'etant pas
   virtualise. Penser a desinstaller la version EXE au prealable, sinon son
   verrou d'instance empeche le paquet de demarrer (voir plus haut).

## Etat des verifications

Fait et mesure sur le paquet installe en sideload :

- Identite enregistree par Windows :
  `MehdiJoyen.SoocialDesktop_6sysvkg83wmrg!Soocial`, conforme au manifeste.
- `SoocialStartup` enregistre avec `State = 0` : declare, desactive, activable
  par l'utilisateur.
- Le paquet demarre et reprend le profil existant.
- Aucune ecriture hors du dossier de donnees.

### Windows App Certification Kit

Passe sur le paquet installe, type detecte « Centennial ». **22 PASS, 1 FAIL,
1 WARNING.**

Le FAIL porte sur « Fichiers executables bloques », test marque
`OPTIONAL="TRUE"`. Sur 25 messages, 23 sont des faux positifs : WACK cherche des
noms d'executables interdits (`reg`, `cmd`, `bash`, `csi`, `cdb`, `dnx`) par
balayage de chaines, et les trouve dans les fichiers de donnees de Chromium
(`icudtl.dat`, `resources.pak`, `*.pak`, `d3dcompiler_47.dll`,
`vk_swiftshader.dll`, `dxcompiler.dll`). La casse le trahit : « CsI », « CDb »,
« rEG », « BasH » sont des sequences d'octets, pas des references. Le
`CreateProcessW` de `Soocial.exe` est inherent a Electron, et permis a un paquet
`runFullTrust`.

Trois occurrences etaient reelles, dans `app.asar` : `powershell`, `cmd`, `CsI`.
Elles venaient de
`electron-updater/out/windowsExecutableCodeSignatureVerifier.js`, embarque dans
l'asar bien que le build Store ne le charge jamais. **Corrige depuis la 1.0.1**
en excluant `electron-updater` du paquet Store (voir plus bas). Le canal NSIS le
conserve : il en depend pour sa mise a jour automatique.

Le WARNING DPI est un artefact. Le rapport annonce « Impossible de traiter le
binaire » avant de conclure a l'absence de compatibilite DPI, alors que
`Soocial.exe` declare `dpiAware>true/pm`. Le seul test obligatoire du lot n'a donc
produit qu'un avertissement infonde.

Pour rejouer, en console administrateur :

```powershell
$appcert = "C:\Program Files (x86)\Windows Kits\10\App Certification Kit\appcert.exe"
& $appcert reset
& $appcert test -packagefullname MehdiJoyen.SoocialDesktop_1.0.0.0_x64__6sysvkg83wmrg -reportoutputpath .\dist\wack-report.xml
```

WACK deploie le paquet pour le tester : il lui faut donc le paquet **signe**, ou
comme ici celui deja installe. Le `-store.msix` non signe ne peut pas etre teste
directement.

**Piege : WACK laisse le paquet dans un etat de debogage.** Apres son passage,
l'application se lance suspendue — un seul process, un seul thread,
`WaitReason = Suspended`, zero seconde de CPU. Aucune fenetre n'apparait et les
activations suivantes ne font rien, puisqu'elles passent la main a l'instance
suspendue. Le code n'est jamais execute : ce n'est pas un defaut applicatif, et
ca ne concerne que la machine de test — WACK ne tourne jamais chez un
utilisateur.

Diagnostic en une commande :

```powershell
(Get-Process Soocial).Threads[0] | Select-Object ThreadState, WaitReason
```

Remise en etat, du moins invasif au plus sur :

```powershell
& $appcert reset
# si insuffisant :
Get-AppxPackage -Name MehdiJoyen.SoocialDesktop | Remove-AppxPackage
Add-AppxPackage -Path .\dist\Soocial-<version>-sideload.msix
```

Un symptome voisin a ete observe dans le meme etat — l'application se relancait
seule apres une sortie par la zone de notification — et a disparu avec le meme
nettoyage. Non reproduit depuis, cause non formellement etablie.

Reste a valider a la main, faute de pouvoir l'automatiser :

- Affichage d'un toast sur message entrant (la fonction phare).
- Icone et repli dans la zone de notification.
- Activation du demarrage automatique puis redemarrage.
- Persistance des sessions isolees apres redemarrage.
