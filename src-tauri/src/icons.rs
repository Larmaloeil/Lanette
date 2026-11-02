//! Icônes : extraction de l'icône réelle via le Shell Windows, cache PNG sur
//! disque, et protocole `icon://` servi en arrière-plan.
//!
//! Le frontend demande `http://icon.localhost/<source encodée>?s=<taille>` ;
//! la requête part dans un petit pool de threads (COM STA), donc l'interface
//! ne bloque jamais, même avec des centaines d'éléments.

use crate::config;
use crate::shell::ComGuard;
use std::path::Path;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Runtime, UriSchemeContext, UriSchemeResponder};
use windows::core::{Interface, HSTRING};
use windows::Win32::Foundation::SIZE;
use windows::Win32::Graphics::Gdi::{
    DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
    BI_RGB, DIB_RGB_COLORS, HBITMAP, HGDIOBJ,
};
use windows::Win32::UI::Shell::{
    IShellItem, IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF, SIIGBF_BIGGERSIZEOK,
    SIIGBF_ICONONLY, SIIGBF_RESIZETOFIT,
};

const WORKERS: usize = 3;
const ALLOWED_SIZES: [u32; 7] = [16, 24, 32, 48, 64, 96, 128];

struct Job {
    source: String,
    size: u32,
    responder: UriSchemeResponder,
}

static POOL: OnceLock<Mutex<Sender<Job>>> = OnceLock::new();

fn pool() -> &'static Mutex<Sender<Job>> {
    POOL.get_or_init(|| {
        let (tx, rx) = channel::<Job>();
        let rx = Arc::new(Mutex::new(rx));
        for i in 0..WORKERS {
            let rx: Arc<Mutex<Receiver<Job>>> = rx.clone();
            std::thread::Builder::new()
                .name(format!("icon-worker-{i}"))
                .spawn(move || {
                    let _com = ComGuard::new();
                    loop {
                        let job = match rx.lock() {
                            Ok(r) => match r.recv() {
                                Ok(j) => j,
                                Err(_) => return,
                            },
                            Err(_) => return,
                        };
                        let resp = serve(&job.source, job.size);
                        job.responder.respond(resp);
                    }
                })
                .expect("thread icônes");
        }
        Mutex::new(tx)
    })
}

/// Point d'entrée du protocole (appelé par Tauri pour chaque <img>).
pub fn protocol_handler<R: Runtime>(
    _ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let uri = request.uri();
    let source = percent_decode(uri.path().trim_start_matches('/'));
    let size = uri
        .query()
        .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("s=")))
        .and_then(|v| v.parse::<u32>().ok())
        .map(snap_size)
        .unwrap_or(64);
    if source.is_empty() {
        responder.respond(not_found());
        return;
    }
    let job = Job { source, size, responder };
    if let Ok(tx) = pool().lock() {
        if let Err(e) = tx.send(job) {
            e.0.responder.respond(not_found());
        }
    }
}

fn snap_size(s: u32) -> u32 {
    *ALLOWED_SIZES.iter().find(|&&a| a >= s).unwrap_or(&128)
}

fn not_found() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Vec::new())
        .unwrap()
}

fn ok(bytes: Vec<u8>, mime: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "max-age=604800")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(bytes)
        .unwrap()
}

fn image_mime(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        _ => return None,
    })
}

fn serve(source: &str, size: u32) -> Response<Vec<u8>> {
    let source = crate::shell::expand_env(source);
    // Image personnalisée : servie telle quelle (le navigateur sait l'afficher).
    if let Some(mime) = image_mime(&crate::shell::ext_lower(&source)) {
        if let Ok(meta) = std::fs::metadata(&source) {
            if meta.len() <= 8 * 1024 * 1024 {
                if let Ok(bytes) = std::fs::read(&source) {
                    return ok(bytes, mime);
                }
            }
        }
        return not_found();
    }

    let key = cache_key(&source, size);
    let cache_file = config::icon_cache_dir().join(format!("{key:016x}.png"));
    if let Ok(bytes) = std::fs::read(&cache_file) {
        return ok(bytes, "image/png");
    }
    match unsafe { extract_png(&source, size as i32) } {
        Some(png) => {
            let _ = std::fs::create_dir_all(config::icon_cache_dir());
            let _ = config::write_atomic(&cache_file, &png, None);
            ok(png, "image/png")
        }
        None => not_found(),
    }
}

/// Clé de cache stable (FNV-1a) : source + taille + date de modification, pour
/// que l'icône se mette à jour quand le programme est mis à jour.
fn cache_key(source: &str, size: u32) -> u64 {
    let mtime = std::fs::metadata(source)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut h: u64 = 0xcbf29ce484222325;
    let mut feed = |b: &[u8]| {
        for &x in b {
            h ^= x as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
    };
    feed(source.to_lowercase().as_bytes());
    feed(&size.to_le_bytes());
    feed(&mtime.to_le_bytes());
    h
}

unsafe fn extract_png(source: &str, size: i32) -> Option<Vec<u8>> {
    if !source.starts_with("shell:") && !Path::new(source).exists() {
        return None;
    }
    let item: IShellItem = SHCreateItemFromParsingName(&HSTRING::from(source), None).ok()?;
    let factory: IShellItemImageFactory = item.cast().ok()?;
    let flags: SIIGBF = SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK | SIIGBF_RESIZETOFIT;
    let hbmp = factory.GetImage(SIZE { cx: size, cy: size }, flags).ok()?;
    let res = hbitmap_to_png(hbmp);
    let _ = DeleteObject(HGDIOBJ(hbmp.0));
    res
}

unsafe fn hbitmap_to_png(hbmp: HBITMAP) -> Option<Vec<u8>> {
    let mut bm = BITMAP::default();
    let got = GetObjectW(
        HGDIOBJ(hbmp.0),
        std::mem::size_of::<BITMAP>() as i32,
        Some(&mut bm as *mut _ as *mut _),
    );
    if got == 0 || bm.bmWidth <= 0 || bm.bmHeight == 0 {
        return None;
    }
    let w = bm.bmWidth;
    let h = bm.bmHeight.abs();
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // négatif = lignes de haut en bas
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut buf = vec![0u8; (w * h * 4) as usize];
    let hdc = GetDC(None);
    let lines = GetDIBits(
        hdc,
        hbmp,
        0,
        h as u32,
        Some(buf.as_mut_ptr() as *mut _),
        &mut info,
        DIB_RGB_COLORS,
    );
    ReleaseDC(None, hdc);
    if lines == 0 {
        return None;
    }

    // BGRA prémultiplié -> RGBA. Certaines vieilles icônes n'ont aucun canal
    // alpha : on les rend alors opaques.
    let has_alpha = buf.chunks_exact(4).any(|p| p[3] != 0);
    for px in buf.chunks_exact_mut(4) {
        let (b, g, r, a) = (px[0], px[1], px[2], px[3]);
        if !has_alpha {
            px[0] = r;
            px[2] = b;
            px[3] = 255;
        } else if a == 0 {
            px.copy_from_slice(&[0, 0, 0, 0]);
        } else {
            let un = |c: u8| ((c as u32 * 255 + a as u32 / 2) / a as u32).min(255) as u8;
            px[0] = un(r);
            px[1] = un(g);
            px[2] = un(b);
        }
    }

    let mut out = Vec::with_capacity(buf.len() / 3);
    {
        let mut enc = png::Encoder::new(&mut out, w as u32, h as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut writer = enc.write_header().ok()?;
        writer.write_image_data(&buf).ok()?;
    }
    Some(out)
}

pub fn clear_cache() -> Result<(), String> {
    let dir = config::icon_cache_dir();
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Décodage %XX (UTF-8) minimal, sans dépendance.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |c: u8| (c as char).to_digit(16);
            if let (Some(a), Some(b)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((a * 16 + b) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
