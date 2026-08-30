//! JS snippets injected into service webviews.
//!
//! The original Electron app used `audio.js` and `notificationPatch` in
//! `main.js` for the same purpose. Tauri's WebView2/WKWebView/WebKitGTK can't
//! set per-service audio gain directly, so we keep the in-page strategy: the
//! page sets and reads its own media volume, while our layer scales it.

/// Returns the same volume-patch expression used by the Electron version.
pub fn volume_patch(level: f64) -> String {
    format!(
        r#"(() => {{
  window.__soocialVolume = {level};

  const media = HTMLMediaElement.prototype;

  if (!window.__soocialMediaPatched) {{
    const desc = Object.getOwnPropertyDescriptor(media, 'volume');
    window.__soocialMediaDesc = desc;

    Object.defineProperty(media, 'volume', {{
      configurable: true,
      enumerable: desc.enumerable,
      get() {{
        return '__soocialWanted' in this ? this.__soocialWanted : desc.get.call(this);
      }},
      set(value) {{
        this.__soocialWanted = value;
        desc.set.call(this, value * window.__soocialVolume);
      }},
    }});

    const play = media.play;
    media.play = function (...args) {{
      const wanted = '__soocialWanted' in this ? this.__soocialWanted : 1;
      this.__soocialWanted = wanted;
      window.__soocialMediaDesc.set.call(this, wanted * window.__soocialVolume);
      return play.apply(this, args);
    }};

    window.__soocialMediaPatched = true;
  }}

  for (const el of document.querySelectorAll('audio, video')) {{
    const wanted = '__soocialWanted' in el ? el.__soocialWanted : 1;
    el.__soocialWanted = wanted;
    window.__soocialMediaDesc.set.call(el, wanted * window.__soocialVolume);
  }}

  window.__soocialGains = window.__soocialGains || [];

  if (typeof AudioNode !== 'undefined' && !window.__soocialAudioPatched) {{
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (destination, ...rest) {{
      const ctx = this.context;
      if (ctx && destination === ctx.destination) {{
        if (!ctx.__soocialGain) {{
          const gain = ctx.createGain();
          connect.call(gain, ctx.destination);
          ctx.__soocialGain = gain;
          window.__soocialGains.push(gain);
        }}
        ctx.__soocialGain.gain.value = window.__soocialVolume;
        return connect.call(this, ctx.__soocialGain, ...rest);
      }}
      return connect.call(this, destination, ...rest);
    }};
    window.__soocialAudioPatched = true;
  }}

  for (const gain of window.__soocialGains) {{
    try {{ gain.gain.value = window.__soocialVolume; }} catch {{}}
  }}

  return Math.round(window.__soocialVolume * 100) + ' % (' + document.querySelectorAll('audio, video').length + ' media, ' + window.__soocialGains.length + ' gain)';
}})()"#,
        level = format!("{}", level)
    )
}

/// Patch `window.Notification` and service-worker notifications so a muted
/// service can still receive page events without showing native toasts.
pub fn notification_patch(muted: bool) -> String {
    format!(
        r#"(() => {{
  const Native = window.__soocialNativeNotification || window.Notification;
  if (!Native) return 'sans-Notification';

  window.__soocialNativeNotification = Native;
  window.__soocialMuted = {muted};

  if (!window.__soocialPatched) {{
    const Patched = function (title, options) {{
      if (window.__soocialMuted) {{
        return {{ title, body: (options || {{}}).body, close() {{}}, addEventListener() {{}}, removeEventListener() {{}} }};
      }}
      return new Native(title, options);
    }};
    Patched.requestPermission = (...args) => Native.requestPermission(...args);
    Object.defineProperty(Patched, 'permission', {{ get: () => Native.permission }});
    window.Notification = Patched;
    window.__soocialPatched = true;
  }}

  const swProto = window.ServiceWorkerRegistration && window.ServiceWorkerRegistration.prototype;
  if (swProto && swProto.showNotification && !window.__soocialSwPatched) {{
    const nativeShow = swProto.showNotification;
    swProto.showNotification = function (...args) {{
      if (window.__soocialMuted) return Promise.resolve();
      return nativeShow.apply(this, args);
    }};
    window.__soocialSwPatched = true;
  }}

  return (window.__soocialMuted ? 'coupe' : 'actif') + ' [permission Chromium: ' + Native.permission + ' | service worker: ' + (window.__soocialSwPatched ? 'enveloppe' : 'absent') + ']';
}})()"#,
        muted = muted
    )
}
