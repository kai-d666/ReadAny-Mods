use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    routing::any,
    Router,
};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State as TauriState};
use tokio::sync::{oneshot, Mutex};
use tower_http::cors::CorsLayer;
use uuid::Uuid;

#[derive(Clone)]
pub struct LanServerState {
    pub pending_requests: Arc<DashMap<String, oneshot::Sender<LanResponsePayload>>>,
    pub abort_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LanRequestPayload {
    #[serde(alias = "req_id")]
    pub req_id: String,
    pub method: String,
    pub path: String,
    pub headers: std::collections::HashMap<String, String>,
    #[serde(alias = "body_base64")]
    pub body_base64: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LanResponsePayload {
    pub status: u16,
    #[serde(default)]
    pub headers: std::collections::HashMap<String, String>,
    #[serde(alias = "body_base64")]
    pub body_base64: Option<String>,
}

pub fn init(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(LanServerState {
        pending_requests: Arc::new(DashMap::new()),
        abort_handle: Arc::new(Mutex::new(None)),
    });
    Ok(())
}

#[tauri::command]
pub async fn start_lan_server(
    port: u16,
    app: AppHandle,
    state: TauriState<'_, LanServerState>,
) -> Result<u16, String> {
    let mut handle_lock = state.abort_handle.lock().await;
    if handle_lock.is_some() {
        return Err("LAN server already running".into());
    }

    let pending = state.pending_requests.clone();
    
    let router = Router::new()
        .route("/{*path}", any(handler))
        .route("/", any(handler))
        .layer(CorsLayer::permissive())
        .with_state((app.clone(), pending));

    let addr = format!("0.0.0.0:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("Bind error: {}", e))?;
    let bound_port = listener.local_addr().unwrap().port();

    let server_handle = tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            eprintln!("LAN server error: {}", e);
        }
    });

    *handle_lock = Some(server_handle);

    Ok(bound_port)
}

#[tauri::command]
pub async fn stop_lan_server(state: TauriState<'_, LanServerState>) -> Result<(), String> {
    let mut handle_lock = state.abort_handle.lock().await;
    if let Some(handle) = handle_lock.take() {
        handle.abort();
    }
    state.pending_requests.clear();
    Ok(())
}

#[tauri::command]
pub async fn lan_server_respond(
    req_id: String,
    payload: LanResponsePayload,
    state: TauriState<'_, LanServerState>,
) -> Result<(), String> {
    if let Some((_, sender)) = state.pending_requests.remove(&req_id) {
        if let Err(_) = sender.send(payload) {
            eprintln!("[LANServer] Failed to send response via oneshot channel (receiver dropped)");
        }
    } else {
        eprintln!("[LANServer] pending_requests NOT found for req_id: {}", req_id);
    }
    Ok(())
}

async fn handler(
    State((app, pending)): State<(AppHandle, Arc<DashMap<String, oneshot::Sender<LanResponsePayload>>>)>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> axum::response::Response {
    let req_id = Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();

    pending.insert(req_id.clone(), tx);

    let mut headers_map = std::collections::HashMap::new();
    for (name, value) in headers.iter() {
        if let Ok(val_str) = value.to_str() {
            headers_map.insert(name.as_str().to_string(), val_str.to_string());
        }
    }

    let body_base64 = if body.is_empty() {
        None
    } else {
        use base64::{engine::general_purpose, Engine as _};
        Some(general_purpose::STANDARD.encode(&body))
    };

    let path_str = uri.path_and_query().map(|pq| pq.as_str()).unwrap_or(uri.path()).to_string();

    let payload = LanRequestPayload {
        req_id: req_id.clone(),
        method: method.as_str().to_string(),
        path: path_str.clone(),
        headers: headers_map,
        body_base64,
    };

    let target_event = "lan-request";
    if let Err(e) = app.emit(target_event, payload) {
        eprintln!("[LANServer] Failed to emit {}: {}", target_event, e);
    }

    match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
        Ok(Ok(res)) => {
            let mut response_builder = axum::response::Response::builder()
                .status(StatusCode::from_u16(res.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR));
            
            for (k, v) in res.headers {
                response_builder = response_builder.header(k, v);
            }

            let response_body = if let Some(b64) = res.body_base64 {
                use base64::{engine::general_purpose, Engine as _};
                match general_purpose::STANDARD.decode(b64) {
                    Ok(bytes) => axum::body::Body::from(bytes),
                    Err(e) => {
                        eprintln!("[LANServer] Failed to decode response base64 body: {}", e);
                        axum::body::Body::empty()
                    }
                }
            } else {
                axum::body::Body::empty()
            };

            response_builder.body(response_body).unwrap_or_default()
        }
        Ok(Err(oneshot_err)) => {
            eprintln!("[LANServer] oneshot channel closed without response for req_id: {}: {}", req_id, oneshot_err);
            pending.remove(&req_id);
            axum::response::Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(axum::body::Body::from("Internal Server Error: handler dropped"))
                .unwrap()
        }
        Err(_) => {
            eprintln!("[LANServer] Request timeout after 30s for req_id: {}", req_id);
            pending.remove(&req_id);
            axum::response::Response::builder()
                .status(StatusCode::GATEWAY_TIMEOUT)
                .body(axum::body::Body::from("Gateway Timeout"))
                .unwrap()
        }
    }
}
