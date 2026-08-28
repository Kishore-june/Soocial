'use strict';

/**
 * Catalogue de services proposes a l'ajout.
 *
 * Ce n'est qu'une aide a la saisie : chaque champ reste modifiable dans le
 * formulaire avant enregistrement. Une URL qui aurait bouge se corrige a la
 * main, elle ne bloque personne.
 *
 * Aucune image n'est embarquee ici : les logos sont recuperes depuis le site de
 * chaque service et mis en cache (voir catalog-icons.js). Des logos embarques
 * seraient figes alors que les marques changent.
 *
 * `category` est une cle de traduction (cat.<category> dans locales/).
 *
 * `spoof: true` marque les services qui refusent les navigateurs Electron et
 * exigent un User-Agent maquille. Seul WhatsApp est confirme a ce jour ; si un
 * autre service affiche "navigateur non supporte", cocher l'option dans le
 * formulaire suffit, et une pull request est bienvenue.
 *
 * `icon:` force la source de la vignette quand la detection automatique se
 * trompe ou ne trouve que du 32px, illisible a 44px sur un ecran HiDPI. Cas
 * rencontres :
 *   - les produits Google partagent un domaine : les annuaires d'icones
 *     renvoient le G generique pour calendar.google.com comme pour gmail. Les
 *     vraies icones produit sont publiees sur gstatic ;
 *   - app.brevo.com sert un apple-touch-icon annonce en image/png qui n'en est
 *     pas un ;
 *   - les SPA (Vercel, Stripe, ChatGPT...) repondent 200 avec leur index.html
 *     sur les chemins d'icone standards. Leurs vraies icones vivent sur un CDN,
 *     ou passent par le service faviconV2 de Google qui en indexe du 128px.
 */

const CATALOG = [
  // --------------------------------------------------------------- messagerie
  { name: 'WhatsApp', url: 'https://web.whatsapp.com', color: '#25D366', initials: 'WA', category: 'messaging', spoof: true },
  { name: 'Telegram', url: 'https://web.telegram.org', color: '#2AABEE', initials: 'TG', category: 'messaging' },
  { name: 'Discord', url: 'https://discord.com/app', color: '#5865F2', initials: 'DC', category: 'messaging' },
  { name: 'Slack', url: 'https://app.slack.com/client', color: '#4A154B', initials: 'SL', category: 'messaging' },
  { name: 'Messenger', url: 'https://www.messenger.com', color: '#0084FF', initials: 'MS', category: 'messaging' },
  { name: 'Microsoft Teams', url: 'https://teams.microsoft.com', color: '#6264A7', initials: 'MT', category: 'messaging' },
  { name: 'Google Chat', url: 'https://mail.google.com/chat/', color: '#00AC47', initials: 'GC', category: 'messaging', icon: 'https://www.gstatic.com/images/branding/product/2x/chat_2020q4_48dp.png' },
  { name: 'Element', url: 'https://app.element.io', color: '#0DBD8B', initials: 'EL', category: 'messaging' },
  // Skype a ete retire par Microsoft en mai 2025 : web.skype.com redirige vers
  // Teams, logo compris.

  // -------------------------------------------------------------------- email
  { name: 'Gmail', url: 'https://mail.google.com', color: '#EA4335', initials: 'GM', category: 'email', icon: 'https://www.gstatic.com/images/branding/product/2x/gmail_2020q4_48dp.png' },
  { name: 'Outlook', url: 'https://outlook.live.com/mail/', color: '#0078D4', initials: 'OL', category: 'email' },
  { name: 'Proton Mail', url: 'https://mail.proton.me', color: '#6D4AFF', initials: 'PM', category: 'email' },
  { name: 'Fastmail', url: 'https://app.fastmail.com', color: '#0067B9', initials: 'FM', category: 'email' },
  { name: 'Zoho Mail', url: 'https://mail.zoho.com', color: '#E42527', initials: 'ZM', category: 'email' },
  { name: 'Yahoo Mail', url: 'https://mail.yahoo.com', color: '#6001D2', initials: 'YM', category: 'email' },
  { name: 'Tuta', url: 'https://app.tuta.com', color: '#840010', initials: 'TU', category: 'email' },

  // ------------------------------------------------------------- productivite
  { name: 'Google Calendar', url: 'https://calendar.google.com', color: '#4285F4', initials: 'GA', category: 'productivity', icon: 'https://ssl.gstatic.com/calendar/images/dynamiclogo_2020q4/calendar_31_2x.png' },
  { name: 'Google Drive', url: 'https://drive.google.com', color: '#1FA463', initials: 'GD', category: 'productivity', icon: 'https://ssl.gstatic.com/images/branding/product/2x/drive_2020q4_48dp.png' },
  { name: 'Google Keep', url: 'https://keep.google.com', color: '#FBBC04', initials: 'GK', category: 'productivity', icon: 'https://ssl.gstatic.com/keep/icon_2020q4v2_128.png' },
  { name: 'Notion', url: 'https://www.notion.so', color: '#111111', initials: 'NO', category: 'productivity' },
  { name: 'Trello', url: 'https://trello.com', color: '#0079BF', initials: 'TR', category: 'productivity' },
  { name: 'Asana', url: 'https://app.asana.com', color: '#F06A6A', initials: 'AS', category: 'productivity' },
  { name: 'ClickUp', url: 'https://app.clickup.com', color: '#7B68EE', initials: 'CU', category: 'productivity' },
  { name: 'Todoist', url: 'https://app.todoist.com', color: '#E44332', initials: 'TD', category: 'productivity' },
  { name: 'Linear', url: 'https://linear.app', color: '#5E6AD2', initials: 'LI', category: 'productivity' },
  { name: 'Airtable', url: 'https://airtable.com', color: '#18BFFF', initials: 'AT', category: 'productivity' },
  { name: 'Monday', url: 'https://monday.com', color: '#FF3D57', initials: 'MO', category: 'productivity' },
  { name: 'Evernote', url: 'https://www.evernote.com/client/web', color: '#00A82D', initials: 'EV', category: 'productivity', icon: 'https://www.evernote.com/apple-touch-icon.png' },

  // ---------------------------------------------------------------- developpement
  { name: 'GitHub', url: 'https://github.com', color: '#24292F', initials: 'GH', category: 'development' },
  { name: 'GitLab', url: 'https://gitlab.com', color: '#FC6D26', initials: 'GL', category: 'development' },
  { name: 'Bitbucket', url: 'https://bitbucket.org', color: '#0052CC', initials: 'BB', category: 'development' },
  { name: 'Vercel', url: 'https://vercel.com/dashboard', color: '#000000', initials: 'VC', category: 'development', icon: 'https://assets.vercel.com/image/upload/front/favicon/vercel/180x180.png' },
  { name: 'Netlify', url: 'https://app.netlify.com', color: '#00C7B7', initials: 'NL', category: 'development', icon: 'https://www.netlify.com/favicon/apple-touch-icon.png' },
  { name: 'Cloudflare', url: 'https://dash.cloudflare.com', color: '#F38020', initials: 'CF', category: 'development' },
  { name: 'Sentry', url: 'https://sentry.io', color: '#362D59', initials: 'SE', category: 'development' },

  // ------------------------------------------------------------------------ IA
  { name: 'Claude', url: 'https://claude.ai', color: '#D97757', initials: 'CL', category: 'ai' },
  { name: 'ChatGPT', url: 'https://chatgpt.com', color: '#10A37F', initials: 'GP', category: 'ai', icon: 'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://chatgpt.com&size=128' },
  { name: 'Gemini', url: 'https://gemini.google.com', color: '#8E75B2', initials: 'GE', category: 'ai' },
  { name: 'Perplexity', url: 'https://www.perplexity.ai', color: '#20808D', initials: 'PP', category: 'ai' },
  { name: 'Le Chat', url: 'https://chat.mistral.ai', color: '#FA520F', initials: 'MI', category: 'ai' },

  // -------------------------------------------------------------------- medias
  { name: 'Spotify', url: 'https://open.spotify.com', color: '#1DB954', initials: 'SP', category: 'media' },
  { name: 'YouTube', url: 'https://www.youtube.com', color: '#FF0000', initials: 'YT', category: 'media' },
  { name: 'YouTube Music', url: 'https://music.youtube.com', color: '#FF0000', initials: 'YM', category: 'media' },
  { name: 'Deezer', url: 'https://www.deezer.com', color: '#A238FF', initials: 'DZ', category: 'media' },
  { name: 'Twitch', url: 'https://www.twitch.tv', color: '#9146FF', initials: 'TW', category: 'media' },

  // ------------------------------------------------------------------- reseaux
  { name: 'LinkedIn', url: 'https://www.linkedin.com/feed/', color: '#0A66C2', initials: 'IN', category: 'social' },
  { name: 'X', url: 'https://x.com', color: '#000000', initials: 'X', category: 'social' },
  { name: 'Instagram', url: 'https://www.instagram.com', color: '#E4405F', initials: 'IG', category: 'social' },
  { name: 'Facebook', url: 'https://www.facebook.com', color: '#0866FF', initials: 'FB', category: 'social' },
  { name: 'Reddit', url: 'https://www.reddit.com', color: '#FF4500', initials: 'RD', category: 'social' },
  { name: 'Bluesky', url: 'https://bsky.app', color: '#0085FF', initials: 'BS', category: 'social' },

  // ------------------------------------------------------------------ business
  { name: 'Stripe', url: 'https://dashboard.stripe.com', color: '#635BFF', initials: 'ST', category: 'business', icon: 'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://stripe.com&size=128' },
  { name: 'PayPal', url: 'https://www.paypal.com', color: '#003087', initials: 'PP', category: 'business' },
  { name: 'HubSpot', url: 'https://app.hubspot.com', color: '#FF7A59', initials: 'HS', category: 'business' },
  { name: 'Intercom', url: 'https://app.intercom.com', color: '#1F8DED', initials: 'IC', category: 'business', icon: 'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://intercom.com&size=128' },
  { name: 'Crisp', url: 'https://app.crisp.chat', color: '#1972F5', initials: 'CR', category: 'business' },
  { name: 'Brevo', url: 'https://app.brevo.com', color: '#0B996E', initials: 'BV', category: 'business', icon: 'https://icons.duckduckgo.com/ip3/www.brevo.com.ico' },
  { name: 'Redof', url: 'https://app.redof.fr', color: '#2563EB', initials: 'RD', category: 'business' },
];

module.exports = { CATALOG };
