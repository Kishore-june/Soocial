# Icones personnalisees

Depose ici les images a utiliser dans la sidebar, puis reference le nom du fichier
dans `services.js` :

```js
{
  id: 'wa-redlife',
  // ...
  icon: 'wa-redlife.png',
}
```

- Formats : PNG, JPG, ICO (PNG avec fond transparent recommande)
- Taille : 64x64 minimum (redimensionne automatiquement)
- Sans `icon`, l'app recupere la favicon du site ; sans favicon, elle affiche les
  initiales colorees.
