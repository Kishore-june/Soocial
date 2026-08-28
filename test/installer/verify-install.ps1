<#
.SYNOPSIS
    Verifie qu'une installation de Soocial tient ses promesses, la ou elle a ete
    faite.

.DESCRIPTION
    Le dossier d'installation est un choix de l'utilisateur, pas une option de
    l'installeur : ce script est la moitie verifiable de cette phrase. Il ne
    construit rien et n'ecrit nulle part, sauf dans le fichier de reference passe
    a -BaselineFile (liste des dossiers voisins, capturee avant une
    desinstallation pour pouvoir la comparer apres).

    Deux modes :
      installation   la racine attendue existe, le meta-dossier est coherent,
                     les raccourcis et le registre pointent dedans ;
      desinstallation (-AfterUninstall) la racine a disparu, les voisins sont
                     intacts, les entrees sont parties, les donnees sont restees.

    Tout ce qui est verifie ici est verifiable depuis PowerShell. Ce qui ne l'est
    pas -- une session Chromium toujours connectee apres la mise a jour, par
    exemple -- est signale comme NON VERIFIE plutot que passe sous silence.

.PARAMETER Parent
    Le dossier choisi dans la page "Emplacement" (D:\Apps). La racine attendue
    est <Parent>\Soocial.

.PARAMETER Root
    La racine reelle, si elle ne suit pas la regle <Parent>\Soocial (reparation
    d'une installation deplacee a la main).

.PARAMETER AfterUninstall
    Bascule sur le mode desinstallation.

.PARAMETER BaselineFile
    Fichier JSON ecrit en mode installation et relu en mode desinstallation pour
    comparer le contenu du dossier parent.

.EXAMPLE
    .\verify-install.ps1 -Parent 'D:\Apps'
    .\verify-install.ps1 -Parent 'D:\Apps' -AfterUninstall
#>
[CmdletBinding()]
param(
  [string] $Parent,
  [string] $Root,
  [string] $Version,
  [switch] $AfterUninstall,
  [string] $BaselineFile,
  [switch] $PurgeData
)

$ErrorActionPreference = 'Stop'
$script:failed = 0
$script:unchecked = 0

function Assert-True {
  param([string] $Label, [scriptblock] $Test, [string] $Detail = '')
  $ok = $false
  try { $ok = & $Test } catch { $Detail = $_.Exception.Message }
  if ($ok) { Write-Host "OK   $Label" -ForegroundColor Green }
  else { Write-Host "FAIL $Label  $Detail" -ForegroundColor Red; $script:failed++ }
}

function Assert-Known {
  param([string] $Label, [string] $Why)
  Write-Host "SKIP $Label  - non verifiable ici : $Why" -ForegroundColor DarkYellow
  $script:unchecked++
}

# ---------------------------------------------------------------------------
# Ou est l'application
# ---------------------------------------------------------------------------

if (-not $Root) {
  if (-not $Parent) { Write-Error "-Parent ou -Root est requis"; exit 2 }
  $Root = Join-Path $Parent 'Soocial'
}
$Root = [IO.Path]::GetFullPath($Root).TrimEnd('\')
$Parent = Split-Path -Parent $Root
$dirName = Split-Path -Leaf $Root

Write-Host ""
Write-Host "Soocial - verification d'installation" -ForegroundColor Cyan
Write-Host "  racine     : $Root"
Write-Host "  parent     : $Parent"
Write-Host "  attendu    : $(if ($AfterUninstall) { 'desinstalle' } else { 'installe' })"
Write-Host ""

$exe = Join-Path $Root 'Soocial.exe'
$json = Join-Path $Root 'install.json'
$ini = Join-Path $Root 'install.ini'
$data = Join-Path $env:APPDATA 'Soocial'
$cache = Join-Path $env:LOCALAPPDATA 'Soocial'

if ($AfterUninstall) {
  # -------------------------------------------------------------------------
  # Apres la desinstallation : ce qui doit avoir disparu, et ce qui doit rester
  # -------------------------------------------------------------------------
  Assert-True 'le dossier de l''application a disparu' { -not (Test-Path -LiteralPath $Root) }
  Assert-True 'le dossier parent existe encore' { Test-Path -LiteralPath $Parent }
  Assert-True 'le nom du dossier visait bien Soocial' { $dirName -eq 'Soocial' } "etait '$dirName'"

  if ($BaselineFile -and (Test-Path -LiteralPath $BaselineFile)) {
    $before = (Get-Content -LiteralPath $BaselineFile -Raw | ConvertFrom-Json).entries
    $now = (Get-ChildItem -LiteralPath $Parent -Force | Select-Object -ExpandProperty Name)
    $lost = @($before | Where-Object { $_ -ne 'Soocial' -and $now -notcontains $_ })
    Assert-True 'aucun voisin a ete supprime' { $lost.Count -eq 0 } ($lost -join ', ')
  } else {
    Assert-Known 'voisins du dossier parent' 'lancer l''installation avec -BaselineFile avant de desinstaller'
  }

  $startMenu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Soocial.lnk'
  $userStartMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Soocial.lnk'
  Assert-True 'le raccourci du menu Demarrer est parti' {
    -not (Test-Path -LiteralPath $startMenu) -and -not (Test-Path -LiteralPath $userStartMenu)
  }
  $desktop = Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Soocial.lnk'
  $userDesktop = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Soocial.lnk'
  Assert-True 'le raccourci de bureau est parti' {
    -not (Test-Path -LiteralPath $desktop) -and -not (Test-Path -LiteralPath $userDesktop)
  }

  Assert-True 'la cle de registre applicative est partie' {
    -not (Test-Path -LiteralPath 'HKLM:\SOFTWARE\Soocial')
  }
  $uninstallRoot = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
  $leftovers = @(Get-ChildItem -LiteralPath $uninstallRoot -ErrorAction SilentlyContinue |
    Where-Object { $_.GetValue('DisplayName') -like '*Soocial*' })
  Assert-True 'aucune entree "Ajouter ou retirer un programme" ne subsiste' { $leftovers.Count -eq 0 } ($leftovers -join ', ')

  if ($PurgeData) {
    Assert-True 'les donnees etaient detruites sur demande' { -not (Test-Path -LiteralPath $data) }
  } else {
    Assert-True 'les donnees de l''utilisateur sont conservees' { Test-Path -LiteralPath $data } `
      'les reglages et les sessions doivent survivre a une desinstallation'
  }

  Write-Host ""
  Write-Host "desinstallation : $($script:failed) echec(s), $($script:unchecked) point(s) non verifiable" `
    -ForegroundColor $(if ($script:failed) { 'Red' } else { 'Green' })
  exit $(if ($script:failed) { 1 } else { 0 })
}

# ---------------------------------------------------------------------------
# Installation
# ---------------------------------------------------------------------------

Assert-True 'le dossier porte le nom Soocial' { $dirName -eq 'Soocial' } "etait '$dirName'"
Assert-True 'le dossier existe' { Test-Path -LiteralPath $Root }
Assert-True 'l''executable est en place' { Test-Path -LiteralPath $exe }
if (-not (Test-Path -LiteralPath $Root)) {
  Write-Host "`ninstallation : racine absente, la suite n'a pas de sujet" -ForegroundColor Red
  exit 1
}

# Rien d'etranger ne doit trainer a cote : c'est le dossier Soocial qui appartient
# a l'application, pas le parent.
$loose = @(Get-ChildItem -LiteralPath $Root | Where-Object {
    $_.Name -notin @('Soocial.exe', 'Soocial.exe.sig', 'install.json', 'install.ini', '.install-incomplete',
      'locales', 'resources', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'chrome_elf.dll',
      'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll', 'icudtl.dat', 'libEGL.dll', 'libGLESv2.dll',
      'libvulkan.so.1', 'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'vk_swiftshader.dll',
      'vk_swiftshader_icd.json', 'LICENSE.electron.txt', 'LICENSES.chromium.html', 'Uninstall Soocial.exe')
  })
Assert-True 'aucun fichier inattendu dans le dossier' { $loose.Count -eq 0 } (($loose | Select-Object -First 3).Name -join ', ')

$info = Get-Item -LiteralPath $exe | Select-Object -ExpandProperty VersionInfo
Assert-True 'le nom de l''executable est Soocial' { $info.ProductName -match 'Soocial' } "ProductName='$($info.ProductName)'"
Assert-True 'aucune trace de l''ancien nom dans l''executable' {
  (@($info.ProductName, $info.FileDescription, $info.OriginalFilename, $info.CompanyName) -join ' ') -notmatch '(?i)nexus'
}
if ($Version) {
  Assert-True 'la version de l''executable est celle du paquet' { $info.FileVersion -like "$Version*" } $info.FileVersion
}

# Le meta-dossier : c'est lui qui permet une mise a jour sur un chemin custom.
Assert-True 'install.json est present' { Test-Path -LiteralPath $json }
$meta = $null
if (Test-Path -LiteralPath $json) {
  $meta = Get-Content -LiteralPath $json -Raw | ConvertFrom-Json
  Assert-True 'install.json cite le dossier reel' {
    $meta.installPath -and ($meta.installPath.TrimEnd('\') -ieq $Root)
  } "installPath='$($meta.installPath)'"
  Assert-True 'install.json est verifie' { [bool] $meta.verified }
  Assert-True 'install.json porte une architecture' { $meta.architecture -match 'x64|arm64' } $meta.architecture
  Assert-True 'install.json porte un canal de mise a jour' { $meta.channel }
  Assert-True 'install.json porte une date de premiere installation' {
    # TryParse ecrit dans sa variable de sortie : un [ref] $null leverait avant de
    # repondre a la question, et l'assertion passerait pour un bug de script.
    $parsed = [DateTime]::MinValue
    [bool] $meta.firstInstall -and [DateTime]::TryParse($meta.firstInstall, [ref] $parsed)
  } $meta.firstInstall
  if ($Version) {
    Assert-True 'install.json porte la version installee' { $meta.version -eq $Version } $meta.version
  }
}

Assert-True 'install.ini est present' { Test-Path -LiteralPath $ini }
if ((Test-Path -LiteralPath $ini) -and $meta) {
  # Une seule cle justifie le second format : ReadINIStr ne sait pas lire du JSON,
  # et c'est lui qui doit survivre a une mise a jour.
  $iniFirst = (Get-Content -LiteralPath $ini | Where-Object { $_ -match '^\s*firstInstall\s*=' } |
    Select-Object -First 1) -replace '.*=\s*', ''
  Assert-True 'install.ini conserve firstInstall' {
    $iniFirst -and $iniFirst.Trim() -eq $meta.firstInstall.Trim()
  } "ini='$iniFirst' json='$($meta.firstInstall)'"
}

# Raccourcis : ils doivent pointer dans ce dossier, pas a C:.
$shell = New-Object -ComObject WScript.Shell
$links = @()
foreach ($dir in @((Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'),
                  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
                  ([Environment]::GetFolderPath('CommonDesktopDirectory')),
                  ([Environment]::GetFolderPath('DesktopDirectory')))) {
  $candidate = Join-Path $dir 'Soocial.lnk'
  if (Test-Path -LiteralPath $candidate) { $links += (Get-Item -LiteralPath $candidate).FullName }
}
Assert-True 'au moins un raccourci existe' { $links.Count -ge 1 } "$($links.Count) raccourci(s)"
foreach ($link in $links) {
  $target = $shell.CreateShortcut($link).TargetPath
  Assert-True "le raccourci $(Split-Path -Leaf (Split-Path -Parent $link)) pointe dans le dossier" {
    $target -and ($target -like "$Root*")
  } "target='$target'"
}
Assert-True 'aucun raccourci ne pointe vers C:\Program Files par defaut' {
  @($links | ForEach-Object { $shell.CreateShortcut($_).TargetPath } |
    Where-Object { $_ -and $_ -notlike "$Root*" -and $_ -match 'Program Files' }).Count -eq 0
}

# Registre : la cle lisible par l'app, et l'entree de desinstallation.
$key = 'HKLM:\SOFTWARE\Soocial'
Assert-True 'la cle Software\Soocial existe' { Test-Path -LiteralPath $key }
if (Test-Path -LiteralPath $key) {
  $installed = (Get-ItemProperty -LiteralPath $key).InstallLocation
  Assert-True 'le registre cite le dossier reel' { $installed -and ($installed.TrimEnd('\') -ieq $Root) } "registre='$installed'"
}
$uninstallEntry = @(Get-ChildItem -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
  Where-Object { $_.GetValue('DisplayName') -like '*Soocial*' })
Assert-True 'l''entree de desinstallation existe' { $uninstallEntry.Count -eq 1 } "$($uninstallEntry.Count) entree(s)"
if ($uninstallEntry.Count -ge 1) {
  Assert-True 'l''entree de desinstallation cite le dossier reel' {
    ($uninstallEntry[0].GetValue('InstallLocation').TrimEnd('\') -ieq $Root)
  } $uninstallEntry[0].GetValue('InstallLocation')
  Assert-True 'l''executable de desinstallation est dans le dossier' {
    $uninstallEntry[0].GetValue('UninstallString') -like "$Root*"
  } $uninstallEntry[0].GetValue('UninstallString')
}

# Donnees hors du dossier d'application : c'est ce qui rend une mise a jour bon marche.
Assert-True 'les donnees sont dans APPDATA, pas dans le dossier d''installation' {
  Test-Path -LiteralPath $data -and -not (Test-Path -LiteralPath (Join-Path $Root 'config.json'))
} "data='$data'"
Assert-True 'le cache n''est pas dans le dossier d''installation' { -not (Test-Path -LiteralPath (Join-Path $Root 'Cache')) }
Write-Host ""
Write-Host "  Note : la separation par service (un dossier de session par compte) n'est"
Write-Host "         observable qu'apres une connexion : $(Join-Path $data 'Partitions')"
if (Test-Path -LiteralPath (Join-Path $data 'Partitions')) {
  $partitions = @(Get-ChildItem -LiteralPath (Join-Path $data 'Partitions') -Directory)
  Assert-True 'une partition de session par service' { $partitions.Count -ge 1 } "$($partitions.Count) partition(s)"
} else {
  Assert-Known 'cloisonnement des sessions' 'ouvrir l''application et se connecter a deux services'
}

if ($BaselineFile) {
  [PSCustomObject] @{ root = $Root; parent = $Parent; entries = @(
      Get-ChildItem -LiteralPath $Parent -Force | Select-Object -ExpandProperty Name) } |
    ConvertTo-Json | Set-Content -LiteralPath $BaselineFile -Encoding UTF8
  Write-Host "  reference des voisins ecrite dans $BaselineFile"
}

Assert-Known 'la session reste connectee apres une mise a jour' 'exiger une connexion reelle, puis relancer'
Assert-Known 'une installation interrompue se repare' 'couper le courant pendant la copie des fichiers'

Write-Host ""
Write-Host "installation : $($script:failed) echec(s), $($script:unchecked) point(s) non verifiable" `
  -ForegroundColor $(if ($script:failed) { 'Red' } else { 'Green' })
exit $(if ($script:failed) { 1 } else { 0 })
