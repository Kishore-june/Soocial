use serde_json::Value;

pub const FALLBACK: &str = "en";
pub const AVAILABLE: [&str; 3] = ["en", "fr", "es"];

/// Language dictionaries embedded from the repo's `locales/` folder.
///
/// The original Electron app read these from disk in the main process and sent
/// the resolved dictionary to the renderer. We keep the same files as the only
/// source of truth: Rust embeds them at compile time (RAM-friendly, no fs I/O
/// on every bootstrap).
fn dictionaries() -> [Value; 3] {
    [
        serde_json::from_str(include_str!("../../locales/en.json")).unwrap_or(Value::Object(Default::default())),
        serde_json::from_str(include_str!("../../locales/fr.json")).unwrap_or(Value::Object(Default::default())),
        serde_json::from_str(include_str!("../../locales/es.json")).unwrap_or(Value::Object(Default::default())),
    ]
}

/// Resolve a stored preference against the system locale.
/// `preference` is `"system"` or one of `AVAILABLE`.
pub fn resolve(preference: &str) -> String {
    if AVAILABLE.contains(&preference) {
        return preference.to_string();
    }
    let locale = sys_locale::get_locale()
        .map(|value| value.chars().take(2).collect::<String>().to_lowercase())
        .unwrap_or_else(|| FALLBACK.to_string());
    if AVAILABLE.contains(&locale.as_str()) {
        locale
    } else {
        FALLBACK.to_string()
    }
}

pub fn current(preference: &str) -> String {
    resolve(preference)
}

/// Flattened dictionary sent to the renderer.
///
/// English is the reference; missing keys fall back to it, exactly like the
/// Electron `i18n.dict()` helper.
pub fn dict(preference: &str) -> Value {
    let dictionaries = dictionaries();
    let language = resolve(preference);
    let index = if language == "fr" {
        1
    } else if language == "es" {
        2
    } else {
        0
    };
    let mut merged = dictionaries[0].clone();
    if let (Value::Object(target), Value::Object(source)) = (&mut merged, &dictionaries[index]) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }
    merged
}
