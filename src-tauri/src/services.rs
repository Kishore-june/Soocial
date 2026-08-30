use crate::config::{Config, Service};

pub const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/// Normalise an entered address the same way `main.js` did.
/// `web.whatsapp.com` becomes `https://web.whatsapp.com`.
pub fn normalize_url(raw: &str) -> Option<String> {
    let value = raw.trim();
    if value.is_empty() {
        return None;
    }
    let with_scheme = if value.starts_with("http://") || value.starts_with("https://") {
        value.to_string()
    } else {
        format!("https://{}", value)
    };
    url::Url::parse(&with_scheme)
        .ok()
        .map(|url| url.to_string())
}

fn slugify(text: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;
    for ch in text.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(ch);
        } else if out.len() < 32 {
            pending_dash = true;
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() {
        "service".to_string()
    } else {
        out.chars().take(32).collect()
    }
}

/// Generate a free, stable service id based on the name and existing services.
pub fn generate_id(name: &str, config: &Config) -> String {
    let base = slugify(name);
    let taken: std::collections::HashSet<String> =
        config.services.iter().map(|s| s.id.clone()).collect();
    let mut id = base.clone();
    let mut n = 2;
    while taken.contains(&id) {
        id = format!("{}-{}", base, n);
        n += 1;
    }
    id
}

pub fn with_defaults(service: &Service) -> Service {
    Service::with_defaults(service)
}

/// Service rendered for the sidebar. It carries the resolved icon/dataUrl and
/// runtime flags, mirroring Electron's `serviceForRenderer`.
pub fn service_for_renderer(config: &Config, service: &Service) -> serde_json::Value {
    let service = with_defaults(service);
    let muted = config.muted.get(&service.id).copied().unwrap_or(false);
    let volume = clamp_volume(config.volumes.get(&service.id).copied(), 100.0);
    let protected = config
        .protected
        .get(&service.id)
        .map(|state| state.has_hash())
        .unwrap_or(false);
    let favorite = config.favorites.contains(&service.id);
    let icon = stored_icon(config, &service.id);

    serde_json::json!({
        "id": service.id,
        "name": service.name,
        "url": service.url,
        "color": service.color,
        "initials": service.initials,
        "spoofUserAgent": service.spoof_user_agent,
        "preload": service.preload,
        "hibernateAfter": service.hibernate_after,
        "hibernating": false,
        "muted": muted,
        "volume": volume,
        "protected": protected,
        "favorite": favorite,
        "dataUrl": icon.clone(),
        "source": if icon.is_some() { "user".to_string() } else { "".to_string() },
    })
}

pub fn stored_icon(config: &Config, id: &str) -> Option<String> {
    config.icons.get(id).cloned()
}

pub fn clamp_volume(value: Option<f64>, fallback: f64) -> f64 {
    let number = value.unwrap_or(fallback);
    if !number.is_finite() {
        fallback
    } else {
        number.round().clamp(0.0, 100.0)
    }
}

pub fn effective_level(config: &Config, id: &str) -> f64 {
    let service = clamp_volume(config.volumes.get(id).copied(), 100.0) / 100.0;
    let master = clamp_volume(Some(config.master_volume), 100.0) / 100.0;
    service * master
}

pub fn user_agent_for(service: &Service) -> Option<String> {
    if service.spoof_user_agent {
        Some(CHROME_UA.to_string())
    } else {
        None
    }
}

pub fn dnd_compute(choice: &str, now: i64) -> i64 {
    match choice {
        "30" => now + 30 * 60 * 1000,
        "60" => now + 60 * 60 * 1000,
        "morning" => {
            use chrono::{Duration, TimeZone};
            let now_dt = chrono::Local::now();
            let mut candidate = now_dt
                .date_naive()
                .and_hms_opt(8, 0, 0)
                .and_local_timezone(chrono::Local)
                .earliest()
                .unwrap_or(now_dt);
            if candidate.timestamp_millis() <= now {
                candidate += Duration::days(1);
            }
            candidate.timestamp_millis()
        }
        "on" => -1,
        _ => 0,
    }
}

/// Save/update a service draft. Returns `{ ok, id, error? }` as JSON.
pub fn save_service(config: &mut Config, draft: &serde_json::Value) -> serde_json::Value {
    let name = draft
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let raw_url = draft
        .get("url")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let Some(url) = normalize_url(&raw_url) else {
        return serde_json::json!({ "error": "error.urlInvalid" });
    };
    if name.is_empty() {
        return serde_json::json!({ "error": "error.nameRequired" });
    }

    let existing = draft
        .get("id")
        .and_then(|value| value.as_str())
        .filter(|id| !id.is_empty());
    let id = match existing {
        Some(id) => id.to_string(),
        None => generate_id(&name, config),
    };

    let current = config
        .services
        .iter()
        .find(|service| service.id == id)
        .cloned();
    let merged = Service {
        id: id.clone(),
        name,
        url,
        color: draft
            .get("color")
            .and_then(|value| value.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("#45475a")
            .to_string(),
        initials: draft
            .get("initials")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .chars()
            .take(4)
            .collect(),
        spoof_user_agent: draft
            .get("spoofUserAgent")
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
        preload: draft
            .get("preload")
            .and_then(|value| value.as_bool())
            .unwrap_or(true),
        hibernate_after: draft
            .get("hibernateAfter")
            .and_then(|value| value.as_f64())
            .unwrap_or(0.0),
        icon: current.as_ref().and_then(|service| service.icon.clone()),
        partition: Some(format!("persist:{}", id)),
    };

    let mut services = std::mem::take(&mut config.services);
    if let Some(index) = services.iter().position(|service| service.id == id) {
        services[index] = merged;
    } else {
        services.push(merged.clone());
        if !config.order.contains(&id) {
            config.order.push(id.clone());
        }
    }
    config.services = services;
    serde_json::json!({ "ok": true, "id": id })
}

/// Returns `{ ok }` if the draft used by onboarding can be applied.
pub fn onboard_complete(config: &mut Config, drafts: &serde_json::Value) -> serde_json::Value {
    let mut count = 0;
    if let Some(picks) = drafts.as_array() {
        for draft in picks {
            let result = save_service(config, draft);
            if result.get("ok").and_then(|value| value.as_bool()).unwrap_or(false) {
                count += 1;
            }
        }
    }
    config.onboarded = true;
    serde_json::json!({ "ok": true, "count": count })
}

pub fn delete_service(config: &mut Config, id: &str) {
    config.services.retain(|service| service.id != id);
    config.order.retain(|entry| entry != id);
    config.favorites.retain(|entry| entry != id);
    config.icons.remove(id);
    config.muted.remove(id);
    config.protected.remove(id);
    if config.split_id.as_deref() == Some(id) {
        config.split_id = None;
    }
}
