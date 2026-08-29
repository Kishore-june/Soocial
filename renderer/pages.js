'use strict';

/* ==========================================================================
   Soocial - pages hors service (Accueil, Favoris, Reglages, Aide)
   ==========================================================================

   Pourquoi ces pages vivent dans la barre laterale et non dans un service : elles
   n'ont pas de session, pas de cookie, pas de webview. Elles tournent dans le
   webContents de la fenetre, celui qui ne voit jamais un site tiers.

   Le routage est decide par le main (hub:page), pas ici : masquer les vues natives
   est une operation qui a des consequences sur les services en arriere-plan, et le
   renderer n'a pas a les connaitre.
   ========================================================================== */

(() => {
  const hub = window.hub;
  if (!hub) return;

  const root = document.getElementById('page-root');
  if (!root) return;

  /** true pendant qu'une fenetre de modale est ouverte (les vues natives doivent rester cachees). */
  let current = null;
  let settings = null;
  let services = [];
  const unread = new Map();

  /**
   * Libelle traduit. `t` est la fonction de sidebar.js, partagee entre les scripts
   * classiques du meme document, alimentee par le dictionnaire que le main envoie.
   *
   * Deuxiemement, le contrat reellement utilise par les appels : `tr(cle, secours,
   * variables)`. Le secours s'affiche quand la cle manque au dictionnaire -- et il
   * est interpole lui aussi, sinon un titre de tuile afficherait litteralement
   * "Ouvrir {name}". Passer le secours comme deuxieme argument de `t` levait un
   * "Cannot use 'in' operator" sur toute la page.
   */
  const tr = (key, fallback, vars) => {
    const fill = (text) => {
      if (!vars || typeof vars !== 'object') return text;
      return String(text).replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
    };
    const rescue = fallback ?? key;
    if (typeof t !== 'function') return fill(rescue);
    let raw;
    try {
      raw = t(key);
    } catch {
      return fill(rescue);
    }
    return raw && raw !== key ? fill(raw) : fill(rescue);
  };

  // -------------------------------------------------------------------------
  // Petit DOM : un constructeur, pas de framework. Ces pages tiennent en 400
  // lignes parce qu'elles n'ont pas d'etat propre : tout passe par hub.updateSettings.
  // -------------------------------------------------------------------------
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      // Le prefixe fait deux caracteres, pas trois : 'onclick' -> 'click'. Un
      // slice(3) attache un evenement nomme 'lick', qui ne se declenche jamais --
      // et comme le reste de la page continue de s'afficher, le seul symptome est
      // une interface entierement inerte. D'ou le test UI, qui clique vraiment.
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function button(label, action, props = {}) {
    return el(
      'button',
      { class: `glass-button ${props.kind || ''}`.trim(), type: 'button', onclick: action, ...props.attrs },
      label
    );
  }

  function row({ title, hint, value, actions }) {
    return el(
      'div',
      { class: 'setting-row' },
      el('div', { class: 'label' }, el('b', {}, title), hint ? el('small', {}, hint) : null),
      el('div', { class: 'value' }, value || null, actions || null)
    );
  }

  function switchRow(key, title, hint) {
    const toggle = el('button', {
      class: 'glass-switch',
      type: 'button',
      role: 'switch',
      'aria-checked': String(Boolean(settings?.[key])),
      'aria-label': title,
      onclick: async () => {
        toggle.disabled = true;
        try {
          const result = await hub.updateSettings({ [key]: !Boolean(settings?.[key]) });
          if (result?.settings) applySettings(result.settings);
          else if (result?.error) flash(root, result.error, 'error');
          // Sans reponse exploitable, l'interrupteur revient a son etat reel :
          // un interrupteur qui affiche ce que l'utilisateur a clique et non ce
          // qui est enregistre est le mensonge le plus court du monde.
          else toggle.setAttribute('aria-checked', String(Boolean(settings?.[key])));
        } catch (err) {
          flash(root, String(err?.message || err), 'error');
          toggle.setAttribute('aria-checked', String(Boolean(settings?.[key])));
        } finally {
          toggle.disabled = false;
        }
      },
    });
    return row({ title, hint, value: toggle });
  }

  function segmentRow(key, title, hint, options) {
    const group = el('div', { class: 'glass-segment', role: 'group', 'aria-label': title });
    for (const option of options) {
      group.append(
        el('button', {
          type: 'button',
          'aria-pressed': String(settings?.[key] === option.value),
          onclick: async () => {
            const result = await hub.updateSettings({ [key]: option.value });
            if (result?.settings) applySettings(result.settings);
          },
        }, tr(option.labelKey, option.fallback))
      );
    }
    return row({ title, hint, value: group });
  }

  function pathCell(path, note) {
    return el(
      'div',
      { class: 'stack' },
      el('div', { class: 'path-cell', title: path || '' }, path || tr('storage.notSet', 'non definit')),
      note ? el('div', { class: `glass-note ${note.kind || ''}` }, note.text) : null
    );
  }

  // -------------------------------------------------------------------------
  // En-tete commun
  // -------------------------------------------------------------------------
  function head(titleKey, fallback, subtitleKey) {
    const close = button(tr('page.close', 'Fermer'), () => hub.setPage(null), {
      kind: 'page-close',
      attrs: { 'data-i18n': 'page.close', title: tr('page.closeHint', 'Revenir au service') },
    });
    return el(
      'div',
      { class: 'page-head' },
      el('h1', {}, tr(titleKey, fallback)),
      subtitleKey ? el('p', { 'data-i18n': subtitleKey }, tr(subtitleKey)) : null,
      close
    );
  }

  // -------------------------------------------------------------------------
  // Accueil
  // -------------------------------------------------------------------------
  function renderHome() {
    const total = services.reduce((sum, service) => sum + (unread.get(service.id) || 0), 0);
    const install = settings?.install;

    root.replaceChildren(
      head('nav.home', 'Accueil', 'home.subtitle'),
      el(
        'section',
        { class: 'settings-group' },
        el('h2', {}, tr('home.services', 'Services')),
        el('div', { class: 'tile-grid' }, ...services.map(tile)),
        services.length
          ? null
          : el('p', { class: 'glass-note' }, tr('home.empty', 'Aucun service. Ajoutez-en un depuis la barre laterale.'))
      ),
      el(
        'section',
        { class: 'settings-group' },
        el('h2', {}, tr('home.storage', 'Stockage')),
        el(
          'div',
          { class: 'setting-row' },
          el(
            'div',
            { class: 'label' },
            el('b', {}, tr('storage.downloads', 'Dossier de telechargement')),
            el('small', {}, settings?.storage?.downloads || '')
          ),
          el(
            'div',
            { class: 'value' },
            settings?.storage?.downloadsOk
              ? null
              : el('span', { class: 'glass-note error' }, tr('storage.downloadsUnwritable', 'non accessible'))
          )
        ),
        el(
          'div',
          { class: 'setting-row' },
          el(
            'div',
            { class: 'label' },
            el('b', {}, tr('install.title', 'Emplacement de l\u2019application')),
            el('small', {}, install?.installDir || '')
          ),
          el(
            'div',
            { class: 'value' },
            install && install.consistency !== 'match'
              ? el('span', { class: 'glass-note error' }, tr(`install.${install.consistency}`, 'chemin a verifier'))
              : null,
            button(tr('settings.open', 'Ouvrir les reglages'), () => hub.setPage('settings'))
          )
        )
      ),
      total
        ? el('p', { class: 'glass-note' }, tr('home.unreadTotal', '{count} non lus en tout', { count: total }))
        : null
    );
  }

  function tile(service) {
    const count = unread.get(service.id) || 0;
    const avatar = el(
      'div',
      { class: 'avatar', style: `background:${service.color || 'var(--surface-solid)'}` },
      service.icon ? el('img', { src: service.icon, alt: '' }) : service.initials || '?'
    );
    return el(
      'button',
      {
        class: 'glass-tile',
        type: 'button',
        onclick: () => hub.select(service.id),
        title: tr('home.openTile', 'Ouvrir {name}', { name: service.name }),
      },
      avatar,
      el(
        'div',
        { class: 'meta' },
        el('b', {}, service.name),
        el('small', {}, shortHost(service.url))
      ),
      count ? el('span', { class: 'glass-badge' }, count > 99 ? '99+' : String(count)) : null,
      service.muted ? el('span', { class: 'glass-note', title: tr('sidebar.muted', 'Muet') }, '\u2298') : null,
      service.hibernating
        ? el('span', { class: 'glass-note', title: tr('overlay.sleepingTitle', 'En veille') }, '\u23F8')
        : null
    );
  }

  function shortHost(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url || '';
    }
  }

  // -------------------------------------------------------------------------
  // Favoris
  // -------------------------------------------------------------------------
  function renderFavorites() {
    const favorites = services.filter((service) => service.favorite);

    root.replaceChildren(
      head('nav.favorites', 'Favoris', 'favorites.subtitle'),
      favorites.length
        ? el('div', { class: 'tile-grid' }, ...favorites.map(tile))
        : el(
            'div',
            { class: 'setting-row' },
            el(
              'div',
              { class: 'label' },
              el('b', {}, tr('favorites.empty', 'Aucun favori')),
              el('small', {}, tr('favorites.emptyHint', 'Clic droit sur un service, puis Etoiler.'))
            ),
            el('div', { class: 'value' }, button(tr('nav.home', 'Accueil'), () => hub.setPage('home')))
          )
    );
  }

  // -------------------------------------------------------------------------
  // Reglages
  // -------------------------------------------------------------------------
  const SECTIONS = [
    { id: 'general', labelKey: 'settings.general', fallback: 'General' },
    { id: 'appearance', labelKey: 'settings.appearance', fallback: 'Apparence' },
    { id: 'notifications', labelKey: 'settings.notifications', fallback: 'Notifications' },
    { id: 'storage', labelKey: 'settings.storage', fallback: 'Stockage' },
    { id: 'services', labelKey: 'settings.services', fallback: 'Services' },
    { id: 'privacy', labelKey: 'settings.privacy', fallback: 'Confidentialite' },
    { id: 'advanced', labelKey: 'settings.advanced', fallback: 'Avance' },
  ];

  let section = 'general';

  function renderSettings() {
    const nav = el(
      'nav',
      { class: 'settings-nav', 'aria-label': tr('settings.nav', 'Rubriques des reglages') },
      ...SECTIONS.map((entry) =>
        el('button', {
          type: 'button',
          'aria-current': String(section === entry.id),
          onclick: () => {
            section = entry.id;
            renderSettings();
          },
        }, tr(entry.labelKey, entry.fallback))
      )
    );

    const body = el('div', { class: 'settings-body' }, ...sectionContent());
    root.replaceChildren(
      head('nav.settings', 'Reglages', 'settings.subtitle'),
      el('div', { class: 'settings-shell' }, nav, body)
    );
  }

  function sectionContent() {
    switch (section) {
      case 'appearance':
        return [
          group('settings.group.look', 'Apparence', [
            segmentRow('theme', tr('settings.theme', 'Theme'), tr('settings.themeHint', 'Systeme suit Windows.'), [
              { value: 'system', labelKey: 'theme.system', fallback: 'Systeme' },
              { value: 'light', labelKey: 'theme.light', fallback: 'Clair' },
              { value: 'dark', labelKey: 'theme.dark', fallback: 'Sombre' },
            ]),
            segmentRow('glass', tr('settings.glass', 'Effet verre'), tr('settings.glassHint', 'Seul le flou coute : "Etendu" floute plus de surfaces, "Aucun" rend tout opaque.'), [
              { value: 'off', labelKey: 'glass.off', fallback: 'Aucun' },
              { value: 'soft', labelKey: 'glass.soft', fallback: 'Discret' },
              { value: 'full', labelKey: 'glass.full', fallback: 'Etendu' },
            ]),
            segmentRow('animations', tr('settings.animations', 'Animations'), tr('settings.animationsHint', 'Reduit sur les PC lents et pour prefers-reduced-motion.'), [
              { value: 'full', labelKey: 'animations.full', fallback: 'Completes' },
              { value: 'reduced', labelKey: 'animations.reduced', fallback: 'Reduites' },
              { value: 'off', labelKey: 'animations.off', fallback: 'Aucunes' },
            ]),
            switchRow('sidebarCollapsed', tr('settings.sidebarCollapsed', 'Barre laterale repliee'), tr('settings.sidebarCollapsedHint', 'Icones seules : plus de place pour le service.')),
          ]),
        ];

      case 'notifications':
        return [
          group('settings.group.notifications', 'Notifications', [
            row(
              {
                title: tr('sidebar.dnd', 'Ne pas deranger'),
                hint: tr('settings.dndHint', 'Coupe notifications et sons de tous les services.'),
                value: settings?.dnd?.active
                  ? el('span', { class: 'glass-note ok' }, tr('dnd.on', 'Actif'))
                  : el('span', { class: 'glass-note' }, tr('dnd.off', 'Inactif')),
                actions: button(tr('settings.dndButton', 'Choisir une duree'), () => hub.dndMenu()),
              }
            ),
            switchRow('closeToTray', tr('settings.closeToTray', 'Fermer reduit dans la zone de notification'), tr('settings.closeToTrayHint', 'Sinon la croix quitte l\u2019application.')),
            switchRow('minimizeToTray', tr('settings.minimizeToTray', 'Reduire dans la zone de notification'), tr('settings.minimizeToTrayHint', 'Le bouton du gauche, pas la barre des taches.')),
          ]),
          group('settings.group.sound', 'Son', [
            row({
              title: tr('sidebar.mixer', 'Melangeur'),
              hint: tr('settings.mixerHint', 'Volume par service, maitre compris.'),
              // Le melangeur vit dans la barre laterale : le declencher ici
              // revient a cliquer son bouton, pas a dupliquer sa logique.
              actions: button(tr('settings.mixerOpen', 'Ouvrir'), () => document.getElementById('mixer-btn')?.click()),
            }),
          ]),
        ];

      case 'storage':
        return [
          group('settings.group.downloads', 'Telechargements'),
          downloadsSection(),
          group('settings.group.locations', 'Emplacements'),
          locationsSection(),
        ];

      case 'services':
        return servicesSection();

      case 'privacy':
        return [
          group('settings.group.privacy', 'Confidentialite et sessions', [
            row({
              title: tr('settings.isolation', 'Un service = une session'),
              hint: tr('settings.isolationHint', 'Chaque service a son propre espace de cookies. Aucun ne voit la session d\u2019un autre.'),
              value: el('span', { class: 'glass-note ok' }, tr('common.on', 'actif')),
            }),
            ...services.map((service) =>
              row({
                title: service.name,
                hint: tr('privacy.lockHint', 'Demande le code a chaque ouverture.'),
                value: el(
                  'button',
                  {
                    class: 'glass-switch',
                    type: 'button',
                    role: 'switch',
                    'aria-checked': String(Boolean(service.protected)),
                    'aria-label': tr('privacy.lockService', 'Proteger {name}', { name: service.name }),
                    onclick: async () => {
                      await hub.protectService({ id: service.id, protected: !service.protected });
                      refresh();
                    },
                  }
                ),
              })
            ),
            row({
              title: tr('lock.title', 'Code de verrouillage'),
              hint: settings?.hasLock ? tr('lock.configured', 'Configure') : tr('lock.notConfigured', 'Aucun code'),
              actions: button(tr('lock.configure', 'Configurer'), () => hub.openLockSetup()),
            }),
            row({
              title: tr('settings.clearAll', 'Deconnecter tous les services'),
              hint: tr('settings.clearAllHint', 'Vide les sessions : les services restent installes, les comptes se deconnectent.'),
              actions: button(tr('settings.clearAllButton', 'Vider'), async () => {
                for (const service of services) await hub.serviceAction(service.id, 'reset');
                refresh();
              }, { kind: 'danger' }),
            }),
          ]),
        ];

      case 'advanced':
        return advancedSection();

      default:
        return [
          group('settings.group.start', 'Demarrage et langue', [
            switchRow('autostart', tr('settings.autostart', 'Lancer au demarrage de Windows'), tr('settings.autostartHint', "L'entree est ecrite dans le registre utilisateur, pas dans Program Files.")),
            switchRow('autostartHidden', tr('settings.autostartHidden', 'Demarrer reduit')),
            row({
              title: tr('settings.language', 'Langue'),
              hint: tr('settings.languageHint', 'Systeme suit la langue de Windows.'),
              value: languageSelect(),
            }),
            switchRow('spellcheck', tr('settings.spellcheck', 'Verificateur d\u2019orthographe')),
          ]),
          group('settings.group.about', 'A propos', [
            row({
              title: `${settings?.productName || 'Soocial'} ${settings?.version || ''}`,
              hint: `Electron ${settings?.electron || '?'} - Chromium ${settings?.chromium || '?'}`,
              actions: button(tr('menu.help.about', 'A propos'), () => hub.about()),
            }),
          ]),
        ];
    }
  }

  function group(titleKey, fallback, rows) {
    return el(
      'section',
      { class: 'settings-group' },
      el('h2', { 'data-i18n': titleKey }, tr(titleKey, fallback)),
      ...(rows || [])
    );
  }

  function downloadsSection() {
    const storage = settings?.storage || {};
    const install = settings?.install || {};

    return el(
      'section',
      { class: 'settings-group' },
      row({
        title: tr('storage.downloads', 'Dossier de telechargement'),
        hint: tr('storage.downloadsHint', 'Separe du dossier d\u2019installation : une mise a jour qui remplace le dossier applicatif ne doit jamais emporter vos fichiers.'),
        value: pathCell(storage.downloads, storage.downloadsWillCreate
          // Le troisieme etat, celui d'une premiere utilisation : ni vert ni rouge.
          // Un rouge sur un dossier simplement absent apprend a ignorer les rouges.
          ? { text: tr('storage.downloadsWillCreate', 'sera cree au premier telechargement'), kind: 'info' }
          : storage.downloadsOk
            ? { text: tr('storage.writable', 'accessible en ecriture'), kind: 'ok' }
            : { text: tr('storage.unwritable', 'inaccessible - les telechargements sont suspendus'), kind: 'error' }),
        actions: el(
          'span',
          {},
          button(tr('storage.choose', 'Choisir...'), async () => {
            const result = await hub.pickDirectory('downloads');
            if (result?.settings) applySettings(result.settings);
            else if (result?.error) flash(root, result.error, 'error');
            else refresh();
          }),
          button(tr('storage.check', 'Verifier'), async () => {
            const info = await hub.verifyStorage();
            const tone = info?.downloadsWillCreate ? 'info' : info?.downloadsOk ? 'ok' : 'error';
            const message = info?.downloadsWillCreate
              ? tr('storage.downloadsWillCreate', 'sera cree au premier telechargement')
              : info?.downloadsOk
                ? tr('storage.ok', 'Dossier accessible')
                : tr('storage.notOk', 'Dossier inaccessible');
            flash(root, message, tone);
            refresh();
          }),
          storage.downloadsIsDefault
            ? null
            : button(tr('storage.reset', 'Revenir au defaut'), async () => {
                const result = await hub.resetDownloads();
                if (result?.settings) applySettings(result.settings);
              })
        ),
      }),
      row({
        title: tr('storage.ask', 'Demander ou enregistrer a chaque telechargement'),
        hint: tr('storage.askHint', 'Sinon le fichier part directement dans le dossier ci-dessus, sans ecraser un homonyme.'),
        value: el('button', {
          class: 'glass-switch',
          type: 'button',
          role: 'switch',
          'aria-checked': String(Boolean(settings?.askWhereToSave)),
          'aria-label': tr('storage.ask', 'Demander ou enregistrer a chaque telechargement'),
          onclick: async () => {
            const result = await hub.updateSettings({ askWhereToSave: !Boolean(settings?.askWhereToSave) });
            if (result?.settings) applySettings(result.settings);
          },
        }),
      }),
      row({
        title: tr('install.title', 'Dossier de l\u2019application'),
        hint: tr('install.hint', "Ecrit par l'installeur. L'app ne le touche jamais : il peut etre sur un disque amovible, et un disque retire ne se repare pas avec une reinstalle."),
        value: pathCell(install.installDir, install.consistency === 'match'
          ? null
          : { text: tr(`install.${install.consistency}`, 'chemin a verifier'), kind: 'error' }),
        actions: button(tr('install.openFolder', 'Ouvrir'), () => hub.openLocation('install')),
      }),
      row({
        title: tr('storage.metadata', 'Metadonnees d\u2019installation'),
        hint: `${install.metadataPath || ''}${install.hasMetadata ? '' : ' - install.json absent'}`,
        value: el('span', { class: `glass-note ${install.hasMetadata ? 'ok' : 'error'}` },
          install.hasMetadata ? tr('storage.metadataOk', 'lisibles') : tr('storage.metadataMissing', 'absentes (reparer via l\u2019installeur)')),
      })
    );
  }

  function locationsSection() {
    const storage = settings?.storage || {};
    const entries = [
      ['data', tr('storage.data', 'Donnees (sessions, reglages)'), storage.data],
      ['cache', tr('storage.cache', 'Cache'), storage.cache],
      ['downloads', tr('storage.downloads', 'Telechargements'), storage.downloads],
    ];

    return el(
      'section',
      { class: 'settings-group' },
      ...entries.map(([kind, label, value]) =>
        row({
          title: label,
          hint: storage.dataNote && kind === 'data' ? storage.dataNote : undefined,
          value: pathCell(value),
          actions: button(tr('storage.open', 'Ouvrir'), () => hub.openLocation(kind)),
        })
      )
    );
  }

  function servicesSection() {
    const rows = services.map((service) =>
      row({
        title: service.name,
        hint: shortHost(service.url),
        value: el(
          'span',
          { class: 'glass-note' },
          unread.get(service.id) ? tr('settings.unreadCount', '{count} non lus', { count: unread.get(service.id) }) : tr('settings.noUnread', 'aucun message en attente')
        ),
        actions: el(
          'span',
          {},
          button(service.favorite ? tr('favorites.remove', 'Retirer des favoris') : tr('favorites.add', 'Favori'), async () => {
            await hub.toggleFavorite(service.id);
            refresh();
          }),
          button(tr('service.reload', 'Recharger'), () => hub.serviceAction(service.id, 'reload')),
          button(service.hibernating ? tr('service.wake', 'Reveiller') : tr('service.sleep', 'Mettre en veille'), () =>
            hub.serviceAction(service.id, service.hibernating ? 'wake' : 'sleep')
          ),
          button(service.muted ? tr('service.unmute', 'Son') : tr('service.mute', 'Muet'), () =>
            hub.serviceAction(service.id, 'mute')
          ),
          button(tr('service.duplicate', 'Dedoubler'), async () => {
            const result = await hub.serviceAction(service.id, 'duplicate');
            if (result?.ok) refresh();
          }),
          button(tr('service.reset', 'Reinitialiser'), () => hub.serviceAction(service.id, 'reset'), { kind: 'danger' })
        ),
      })
    );

    return [
      group('settings.group.services', 'Services', rows),
      el(
        'p',
        { class: 'glass-note' },
        tr('settings.servicesHint', "L'ordre se change en glissant les entrees de la barre laterale. Supprimer un service ne supprime aucune donnee : la session est gardee tant que vous ne videz pas le dossier de donnees.")
      ),
    ];
  }

  function advancedSection() {
    const install = settings?.install || {};
    const update = settings?.update || {};

    return [
      group('settings.group.performance', 'Performance', [
        row({
          title: tr('settings.hardwareAcceleration', 'Acceleration materielle'),
          hint: tr('settings.hardwareAccelerationHint', 'Un redemarrage est necessaire. A couper en cas de clignotements ou d\u2019ecran noir avec certains pilotes.'),
          value: el('button', {
            class: 'glass-switch',
            type: 'button',
            role: 'switch',
            'aria-checked': String(settings?.hardwareAcceleration !== false),
            'aria-label': tr('settings.hardwareAcceleration', 'Acceleration materielle'),
            onclick: async () => {
              const result = await hub.updateSettings({ hardwareAcceleration: settings?.hardwareAcceleration === false });
              if (result?.settings) applySettings(result.settings);
              flash(root, tr('settings.restartNeeded', 'Redemarrez pour appliquer'), 'ok');
            },
          }),
        }),
        row({
          title: tr('settings.hibernate', 'Veille automatique'),
          hint: tr('settings.hibernateHint', "Se regle par service ; au-dela de 5 services actifs, la mise en veille est ce qui tient les 5 premieres secondes fluides."),
          actions: button(tr('settings.openServices', 'Ouvrir Services'), () => {
            section = 'services';
            renderSettings();
          }),
        }),
      ]),
      group('settings.group.updates', 'Mises a jour', [
        row({
          title: tr('update.title', 'Mise a jour'),
          hint: `${tr('update.channel', 'Canal')} : ${install.channel || 'stable'} - ${tr('install.arch', 'Architecture')} : ${install.architecture || 'x64'}`,
          value: el('span', { class: 'glass-note' }, update.state || tr('update.idle', 'aucune verification')),
          actions: el(
            'span',
            {},
            button(tr('update.check', 'Verifier'), async () => {
              const result = await hub.checkUpdates();
              flash(root, describeUpdate(result), result?.state === 'error' ? 'error' : 'ok');
            }),
            pendingVersion() ? button(tr('update.install', 'Installer'), () => hub.installUpdate(), { kind: 'primary' }) : null
          ),
        }),
        row({
          title: tr('install.target', 'Cible de l\u2019installation'),
          hint: tr('install.targetHint', "Avant d'installer une mise a jour, l'app verifie que le chemin enregistre correspond bien a l'endroit ou elle tourne. Un doute arrete l'installation au lieu de repartir sur C:."),
          value: el('span', { class: `glass-note ${install.consistency === 'match' ? 'ok' : 'error'}` },
            install.consistency === 'match'
              ? tr('install.match', 'chemin verifie')
              : tr(`install.${install.consistency}`, 'chemin a verifier')),
        }),
      ]),
      group('settings.group.diagnostics', 'Diagnostics', [
        row({
          title: tr('settings.diagnostics', 'Bloc de diagnostic'),
          hint: tr('settings.diagnosticsHint', 'Chemins, version, registre, raccourcis, acces en ecriture. Rien qui concerne les comptes.'),
          actions: el(
            'span',
            {},
            button(tr('settings.copy', 'Copier'), () => hub.diagnostics({ copy: true })),
            button(tr('storage.open', 'Ouvrir les dossiers'), () => hub.openLocation('data'))
          ),
        }),
      ]),
    ];
  }

  function pendingVersion() {
    return settings?.update?.version || null;
  }

  function describeUpdate(result) {
    switch (result?.state) {
      case 'current':
        return tr('update.availableMessage', "Vous utilisez la derniere version.");
      case 'ready':
        return tr('update.readyMessage', "La mise a jour est telechargee.");
      case 'available':
        return tr('update.availableDownload', "Une version est en telechargement.");
      case 'store':
        return tr('update.storeDetail', "Le Microsoft Store installe les mises a jour.");
      case 'error':
        return result.detail || tr('update.failedMessage', "La verification a echoue.");
      default:
        return tr('update.idle', 'aucune verification');
    }
  }

  function languageSelect() {
    const select = el('select', {
      class: 'glass-field',
      'aria-label': tr('settings.language', 'Langue'),
      onchange: async () => {
        await hub.setLanguage(select.value);
        refresh();
      },
    });
    const options = [{ value: 'system', label: tr('language.system', 'Langue de Windows') }].concat(
      (settings?.languageAvailable || ['en', 'fr', 'es']).map((code) => ({ value: code, label: code.toUpperCase() }))
    );
    for (const option of options) {
      select.append(el('option', { value: option.value, selected: settings?.language === option.value }, option.label));
    }
    return select;
  }

  /** Message court, dans le haut de la page : une boite de dialogue pour "copie faite" serait une popup de trop. */
  function flash(where, text, kind) {
    if (!text) return;
    const note = el('div', { class: `glass-note flash ${kind || ''}` }, text);
    where.prepend(note);
    setTimeout(() => note.remove(), 3200);
  }

  // -------------------------------------------------------------------------
  // Etat et remontees
  // -------------------------------------------------------------------------
  /**
   * Dimensions -> variables CSS. Les noms sont ceux de glass.css ; la valeur
   * vient de shared/layout-metrics.js par le main. C'est le seul endroit ou le
   * renderer apprend une taille, et le seul ou le CSS en recoit une.
   */
  function applyMetrics(metrics) {
    if (!metrics) return;
    const html = document.documentElement;
    const px = (value) => `${value}px`;
    html.style.setProperty('--sidebar-width', px(metrics.sidebarWidth));
    html.style.setProperty('--sidebar-width-collapsed', px(metrics.SIDEBAR_WIDTH_COLLAPSED));
    html.style.setProperty('--titlebar-height', px(metrics.TITLEBAR_HEIGHT));
    html.style.setProperty('--split-gap', px(metrics.SPLIT_GAP));
    html.style.setProperty('--window-button-size', px(metrics.WINDOW_BUTTON_SIZE));
    html.style.setProperty('--window-button-gap', px(metrics.WINDOW_BUTTON_GAP));
    html.style.setProperty('--window-button-inset', px(metrics.WINDOW_BUTTON_INSET));
    html.style.setProperty('--window-glyph-size', px(metrics.WINDOW_GLYPH_SIZE));
  }

  function applySettings(next) {
    settings = next;
    // Les attributs qui pilotent le style sont poses ici, une seule fois : ces
    // trois drapeaux + les dimensions font la totalite du rendu "glass".
    const html = document.documentElement;
    html.dataset.glass = next.glass || 'soft';
    html.dataset.animations = next.animations || 'full';
    html.dataset.sidebarCollapsed = String(Boolean(next.sidebarCollapsed));
    applyMetrics(next.metrics);
    // Le theme (clair/sombre) vient du main : lui seul connait la reponse a
    // "systeme", pas nous.
    draw();
  }

  function draw() {
    if (current === 'home') renderHome();
    else if (current === 'favorites') renderFavorites();
    else if (current === 'settings') renderSettings();
    else if (current === 'help') renderHelp();
    else root.replaceChildren();
    root.hidden = !current;
    markCurrentPage();
    // L'entree unique du menu porte le temoin : un point sous l'icone quand une
    // page est devant. Les quatre boutons d'avant n'en avaient pas besoin, chacun
    // etait deja sa propre rubrique.
    const logo = document.getElementById('rail-logo');
    if (logo) {
      if (current) logo.setAttribute('data-page-open', current);
      else logo.removeAttribute('data-page-open');
    }
  }

  function refresh() {
    hub.settings().then(applySettings);
  }

  /**
   * L'icone du logiciel, en haut de la barre laterale : l'entree unique du menu
   * qui contient les quatre pages. Cable ici et non dans sidebar.js parce que
   * l'etat "page devant" est connu de ce module seul.
   */
  function wireSidebarNav() {
    const logo = document.getElementById('rail-logo');
    if (!logo || logo.dataset.wired) return;
    logo.dataset.wired = '1';
    logo.addEventListener('click', () => {
      const box = logo.getBoundingClientRect();
      logo.setAttribute('aria-expanded', 'true');
      hub.navMenu({ x: Math.round(box.left), y: Math.round(box.bottom) });
    });
    // Le popup est natif : le renderer ne le voit pas se fermer. Le premier
    // evenement qui le suit (perte de focus, clic ailleurs) sert donc d'indication
    // ; un etat laisse a true une seconde de plus ne coute qu'un surbrillage.
    const close = () => logo.removeAttribute('aria-expanded');
    window.addEventListener('blur', close);
    window.addEventListener('pointerdown', (event) => {
      if (!event.target.closest('#rail-logo')) close();
    });
  }

  function markCurrentPage() {
    // Le menu natif marque la page ouverte de lui-meme, il est reconstruit a
    // chaque ouverture. Le DOM n'a plus qu'a signaler que l'icone mene quelque part.
    const logo = document.getElementById('rail-logo');
    if (!logo) return;
    if (current) logo.setAttribute('aria-current', 'page');
    else logo.removeAttribute('aria-current');
  }

  function setServices(next) {
    services = next || [];
    draw();
  }

  function renderHelp() {
    const shortcuts = [
      ['Ctrl+1..9', tr('help.openService', 'Ouvrir le service')],
      ['Ctrl+W', tr('help.closeView', "Fermer la vue partagee")],
      ['Ctrl+Shift+S', tr('help.sleep', 'Mettre le service en veille')],
      ['Ctrl+M', tr('help.mute', 'Couper le son du service')],
      ['Ctrl+Shift+M', tr('help.muteAll', 'Couper tous les sons')],
      ['Ctrl+N', tr('help.next', 'Service suivant')],
      ['Ctrl+,', tr('help.settings', 'Ouvrir les reglages')],
      ['Ctrl+Shift+J', tr('help.devtools', 'Outils de developpement')],
      ['Ctrl+Q', tr('help.quit', 'Quitter')],
      ['Alt', tr('help.menu', 'Menu du service actif')],
    ];

    root.replaceChildren(
      head('nav.help', 'Aide', 'help.subtitle'),
      group('help.shortcuts', 'Raccourcis', shortcuts.map(([keys, label]) =>
        row({ title: label, value: el('span', { class: 'path-cell' }, keys) })
      )),
      group('help.links', 'Documentation', [
        row({
          title: tr('help.docs', 'Readme et captures'),
          hint: tr('help.docsHint', 'Installation, demarrage, reglages.'),
          actions: button(tr('help.docsButton', 'Ouvrir la documentation'), () => hub.openDocs()),
        }),
        row({
          title: tr('menu.help.issue', 'Signaler un probleme'),
          hint: tr('help.issueHint', 'Joignez le bloc de diagnostic : il contient les chemins, la version et l\u2019etat du registre.'),
          actions: button(tr('settings.copy', 'Copier le diagnostic'), () => hub.diagnostics({ copy: true })),
        }),
      ])
    );
  }

  hub.onPage(({ page }) => {
    current = page;
    // Les reglages se relisent a chaque ouverture : un champ modifie ailleurs (un
    // dossier choisi par l'installeur, une langue changee) doit etre juste avant
    // d'etre affiche. Les autres pages n'ont pas ce probleme, elles n'ecrivent rien.
    if (page === 'settings') hub.settings().then(applySettings);
    else draw();
  });

  hub.onTheme(({ theme }) => {
    document.documentElement.dataset.theme = theme || 'dark';
  });

  // Un reglage change n'importe ou (cette page, un raccourci, le tray, l'autre
  // fenetre) doit repeindre cette page : c'est le broadcast du main qui le garantit,
  // pas la bienveillance de l'appelant.
  if (hub.onSettings) hub.onSettings((snapshot) => applySettings(snapshot));

  hub.onServices(({ services: next }) => setServices(next));
  hub.onBadge(({ id, count }) => {
    unread.set(id, count);
    if (current === 'home' || current === 'favorites' || (current === 'settings' && section === 'services')) draw();
  });

  hub.onUpdate?.((update) => {
    if (settings) {
      settings.update = update;
      if (current === 'settings' && section === 'advanced') draw();
    }
  });

  document.addEventListener('hub:i18n', () => {
    if (current) draw();
  });

  // Le bootstrap arrive apres le chargement du script : premiere peinture, puis
  // mise a jour si une page etait deja ouverte (relancement avec lastPage).
  hub.bootstrap().then((boot) => {
    if (boot?.settings) settings = boot.settings;
    if (boot?.metrics) applyMetrics(boot.metrics);
    if (boot?.theme) document.documentElement.dataset.theme = boot.theme;
    if (boot?.settings) {
      document.documentElement.dataset.glass = boot.settings.glass || 'soft';
      document.documentElement.dataset.animations = boot.settings.animations || 'full';
    }
    wireSidebarNav();
    services = boot?.services || services;
    if (boot?.lastPage && !current) current = boot.lastPage;
    draw();
  });
})();
