<#
.SYNOPSIS
  Signe et installe le paquet MSIX en local, pour test hors Store.

.DESCRIPTION
  Le paquet produit par `npm run build:store` n'est pas signe, et c'est voulu :
  le Store resigne lui-meme apres certification. Mais Windows refuse d'installer
  un MSIX non signe. Ce script fabrique donc un certificat auto-signe, l'utilise
  pour signer une COPIE du paquet, et installe cette copie.

  Le certificat doit porter exactement le sujet declare dans
  Package/Identity/Publisher du manifeste. Toute divergence, meme d'un espace,
  fait echouer l'installation avec un message qui ne la nomme pas
  (0x800B0109 / "signature du fichier d'application invalide").

  L'original dist\Soocial-<version>-store.msix n'est jamais modifie : c'est lui
  qu'on televerse dans Partner Center. Le sideload travaille sur
  dist\Soocial-<version>-sideload.msix.

.NOTES
  Les deux dernieres etapes (magasin de certificats machine, installation du
  paquet) exigent une console elevee. Le script s'arrete avec un message clair
  s'il n'est pas administrateur.
#>

[CmdletBinding()]
param(
  # Doit correspondre au caractere pres a Package/Identity/Publisher.
  [string] $Publisher = 'CN=3AEA6691-12A7-4EC5-B304-754AC77D0730',
  [string] $Password  = 'soocial-sideload',
  # Retire le paquet deja installe avant de reinstaller.
  [switch] $Reinstall
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $repo 'dist'

$source = Get-ChildItem -Path $dist -Filter 'Soocial-*-store.msix' -ErrorAction SilentlyContinue |
          Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $source) {
  throw "Aucun paquet dans $dist. Lancer d'abord : npm run build:store"
}

$target = Join-Path $dist ($source.Name -replace '-store\.msix$', '-sideload.msix')
# .pfx = cle privee, sert a signer. .cer = partie publique, seule necessaire
# pour faire confiance a la signature. Ne jamais importer le .pfx dans un
# magasin de confiance : on y installerait la cle privee sans aucune raison.
$pfx    = Join-Path $dist 'soocial-sideload.pfx'
$cer    = Join-Path $dist 'soocial-sideload.cer'

Write-Host "Paquet source : $($source.Name)" -ForegroundColor Cyan

# --- Certificat -------------------------------------------------------------
# Reutilise celui deja emis : le regenerer a chaque fois obligerait a refaire
# confiance au nouveau dans le magasin machine.
$cert = Get-ChildItem Cert:\CurrentUser\My |
        Where-Object { $_.Subject -eq $Publisher -and $_.NotAfter -gt (Get-Date) } |
        Select-Object -First 1

if (-not $cert) {
  Write-Host "Emission d'un certificat auto-signe pour $Publisher" -ForegroundColor Cyan
  $cert = New-SelfSignedCertificate `
    -Type Custom `
    -Subject $Publisher `
    -KeyUsage DigitalSignature `
    -FriendlyName 'Soocial sideload (test uniquement)' `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}Subject Type:End Entity')
} else {
  Write-Host "Certificat existant reutilise : $($cert.Thumbprint)" -ForegroundColor DarkGray
}

$secure = ConvertTo-SecureString -String $Password -Force -AsPlainText
Export-PfxCertificate -Cert "Cert:\CurrentUser\My\$($cert.Thumbprint)" -FilePath $pfx -Password $secure | Out-Null
Export-Certificate  -Cert "Cert:\CurrentUser\My\$($cert.Thumbprint)" -FilePath $cer | Out-Null

# --- Signature d'une copie --------------------------------------------------
$signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\x64\\' } |
            Sort-Object FullName -Descending | Select-Object -First 1
if (-not $signtool) { throw 'signtool.exe introuvable : installer le Windows SDK.' }

Copy-Item $source.FullName $target -Force
& $signtool.FullName sign /fd SHA256 /a /f $pfx /p $Password $target
if ($LASTEXITCODE -ne 0) { throw "Echec de la signature (code $LASTEXITCODE)." }
Write-Host "Signe : $(Split-Path -Leaf $target)" -ForegroundColor Green

# --- Confiance + installation (elevation requise) ---------------------------
$admin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $admin) {
  Write-Host ''
  Write-Warning 'Paquet signe, mais pas installe : les deux etapes suivantes demandent une console administrateur.'
  Write-Host "  Import-Certificate -FilePath '$cer' -CertStoreLocation Cert:\LocalMachine\TrustedPeople" -ForegroundColor Yellow
  Write-Host "  Add-AppxPackage -Path '$target'" -ForegroundColor Yellow
  return
}

Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null

if ($Reinstall) {
  Get-AppxPackage -Name 'MehdiJoyen.NexusMessenger' | Remove-AppxPackage -ErrorAction SilentlyContinue
}

Add-AppxPackage -Path $target
$installed = Get-AppxPackage -Name 'MehdiJoyen.NexusMessenger'

Write-Host ''
Write-Host 'Installe.' -ForegroundColor Green
Write-Host "  PackageFullName : $($installed.PackageFullName)"
Write-Host "  PackageFamilyName : $($installed.PackageFamilyName)"
Write-Host "  AUMID : $($installed.PackageFamilyName)!Soocial"
Write-Host ''
Write-Host 'Cette derniere valeur doit etre celle que Soocial n''ecrase pas au demarrage,' -ForegroundColor DarkGray
Write-Host 'sinon les notifications disparaissent sans erreur.' -ForegroundColor DarkGray
