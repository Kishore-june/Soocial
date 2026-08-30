use serde::{Deserialize, Serialize};

/// Generated from the existing `catalog.js` so the Rust backend and the
/// Electron frontend stay in lock-step. The file is embedded at compile time.
const CATALOG_JSON: &str = include_str!("../catalog-data.json");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct CatalogEntry {
    name: String,
    url: String,
    color: String,
    initials: String,
    category: String,
    #[serde(default)]
    spoof: bool,
    #[serde(default)]
    icon: Option<String>,
}

impl Default for CatalogEntry {
    fn default() -> Self {
        Self {
            name: String::new(),
            url: String::new(),
            color: "#45475a".to_string(),
            initials: String::new(),
            category: "messaging".to_string(),
            spoof: false,
            icon: None,
        }
    }
}

pub fn entries() -> Vec<serde_json::Value> {
    let parsed: Vec<CatalogEntry> =
        serde_json::from_str(CATALOG_JSON).unwrap_or_default();
    parsed
        .into_iter()
        .map(|entry| serde_json::json!({
            "name": entry.name,
            "url": entry.url,
            "color": entry.color,
            "initials": entry.initials,
            "category": entry.category,
            "spoof": entry.spoof,
            "icon": entry.icon,
            "iconKey": icon_key(&entry),
        }))
        .collect()
}

/// Mirrors `catalog-icons.js::keyOf` so the renderer receives the same cache
/// key it used in the Electron version.
fn icon_key(entry: &CatalogEntry) -> String {
    let domain = url::Url::parse(&entry.url)
        .ok()
        .and_then(|url| url.host_str().map(|host| host.to_string()))
        .unwrap_or_default();
    match &entry.icon {
        Some(icon) if !icon.is_empty() => {
            let base = icon
                .split('/')
                .last()
                .unwrap_or("override")
                .split('?')
                .next()
                .unwrap_or("override")
                .chars()
                .take(48)
                .collect::<String>();
            format!("{}#{}", domain, base)
        }
        _ => domain,
    }
}
