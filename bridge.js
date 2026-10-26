#!/usr/bin/env node
/* ============================================================
   TYN Bridge v1.0.0-beta — Complete (state + API aware)
   ============================================================
   Reads:
     apis.json    → { apis: [{token,expiresAt,revoked,...}] }
     config.json  → { shell, termType, cwd, port, ... }
     server.state → "on" | "off" | "killed"

   Behavior:
     - /index.html ALWAYS served while node is running
     - WS /term   → rejected if state≠on OR token invalid/expired/revoked
     - /api/*     → same
     - /check     → 503 if state≠on, 401 if token bad
   ============================================================ */

'use strict';

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const os = require('os');

/* ============================================================
   VERSION & PATHS
   ============================================================ */
const VERSION = '1.0.0-beta';
const VERSION_FULL = 'TYN Bridge v' + VERSION;

const ROOT = __dirname;
const APPS_DIR = path.join(ROOT, 'apps');
const CONFIGS_DIR = path.join(ROOT, 'configs');
const LOGS_DIR = path.join(ROOT, 'logs');
const WEBRUN_DIR = path.join(ROOT, 'runtime');
const NANO_DIR = path.join(ROOT, 'nano');
const APIS_FILE = path.join(ROOT, 'apis.json');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const STATE_FILE = path.join(ROOT, 'server.state');
const INDEX_FILE = 'index.html';
const BASE_PATH = '/index.html';
const WEBRUN_PORT_START = 8080;
const WEBRUN_PORT_END = 8200;

[APPS_DIR, CONFIGS_DIR, LOGS_DIR, WEBRUN_DIR, NANO_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

/* ============================================================
   STATE / CONFIG / APIS LOADERS
   ============================================================ */
function loadConfig() {
  const defaults = {
    shell: 'bash', termType: 'xterm-256color', cwd: '~',
    port: 7700, host: '0.0.0.0',
    webrunPortStart: WEBRUN_PORT_START, webrunPortEnd: WEBRUN_PORT_END,
  };
  try {
    if (!fs.existsSync(CONFIG_FILE)) return defaults;
    return { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch(_) { return defaults; }
}

function getServerState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return 'off';
    return (fs.readFileSync(STATE_FILE, 'utf8').trim() || 'off');
  } catch(_) { return 'off'; }
}

function loadApis() {
  try {
    if (!fs.existsSync(APIS_FILE)) return { apis: [] };
    const d = JSON.parse(fs.readFileSync(APIS_FILE, 'utf8'));
    return Array.isArray(d.apis) ? d : { apis: [] };
  } catch(_) { return { apis: [] }; }
}

function validateApiToken(token) {
  if (!token) return { ok: false, reason: 'missing token' };
  const apis = loadApis().apis || [];
  const found = apis.find(a => a.token === token);
  if (!found) return { ok: false, reason: 'token not found' };
  if (found.revoked) return { ok: false, reason: 'token revoked' };
  if (found.expiresAt && Date.now() > found.expiresAt) {
    return { ok: false, reason: 'token expired', expiredAt: found.expiresAt };
  }
  return { ok: true, api: found };
}

function getFirstValidToken() {
  const apis = loadApis().apis || [];
  const now = Date.now();
  const v = apis.find(a => !a.revoked && (!a.expiresAt || a.expiresAt > now));
  return v ? v.token : '';
}

const CONFIG = loadConfig();
const PORT = parseInt(process.env.PORT || CONFIG.port || 7700);
const HOST = process.env.HOST || CONFIG.host || '0.0.0.0';

/* ============================================================
   LOG HELPERS
   ============================================================ */
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}] [TYN]`, ...a);
const warn = (...a) => console.warn(`[${ts()}] [TYN] ⚠`, ...a);
const err = (...a) => console.error(`[${ts()}] [TYN] ✗`, ...a);

/* ============================================================
   OPTIONAL DEPS
   ============================================================ */
let AdmZip = null; try { AdmZip = require('adm-zip'); } catch(_){}
let pty = null; try { pty = require('node-pty'); } catch(_){}

function hasCommand(cmd) {
  try { execSync(`command -v ${cmd} >/dev/null 2>&1`, { stdio: 'ignore', timeout: 2000 }); return true; }
  catch(_) { return false; }
}
const hasScript = hasCommand('script');
const hasUnzip = hasCommand('unzip');
const hasTar = hasCommand('tar');
const has7z = hasCommand('7z') || hasCommand('7za');
const EXEC_MODE = pty ? 'pty' : (hasScript ? 'script' : 'spawn');

/* ============================================================
   COMMAND MAPPER + Y/N DETECTOR
   ============================================================ */
function mapCommand(cmd) {
  if (typeof cmd !== 'string') return '';
  return cmd.replace(/(^|[^\w-])ync(?=$|[^\w-])/g, '$1pkg');
}

const DEFAULT_YN_PATTERNS = [
  /\[y\/n\]/i, /\(y\/n\)/i, /\[Y\/n\]/, /\(Y\/N\)/,
  /\[yes\/no\]/i, /\(yes\/no\)/i, /continue\?/i, /proceed\?/i,
  /are you sure/i, /do you want to/i, /overwrite\?/i, /replace\?/i,
  /delete\?/i, /confirm\?/i, /\[Y\/n\/a\]/i,
];

function detectYN(text, customPatterns) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  const patterns = customPatterns?.length
    ? [...DEFAULT_YN_PATTERNS, ...customPatterns.map(p => { try { return new RegExp(p,'i'); } catch(_){ return null; } }).filter(Boolean)]
    : DEFAULT_YN_PATTERNS;
  for (const re of patterns) {
    if (re.test(clean)) {
      const lines = clean.split('\n').filter(l => l.trim());
      return (lines[lines.length - 1] || clean).trim().slice(0, 200);
    }
  }
  return null;
}

/* ============================================================
   UTILS
   ============================================================ */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function findFileRecursive(dir, ext) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { const r = findFileRecursive(full, ext); if (r) return r; }
      else if (e.name.toLowerCase().endsWith(ext.toLowerCase())) return full;
    }
  } catch(_){}
  return null;
}
function findFilesRecursive(dir, ext) {
  const out = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...findFilesRecursive(full, ext));
      else if (e.name.toLowerCase().endsWith(ext.toLowerCase())) out.push(full);
    }
  } catch(_){}
  return out;
}
function isPortFree(port) {
  return new Promise(resolve => {
    const t = http.createServer();
    let done = false;
    t.once('error', () => { if (!done) { done = true; resolve(false); } });
    t.once('listening', () => { if (done) return; done = true; t.close(() => resolve(true)); });
    t.listen(port, '0.0.0.0');
  });
}
async function findFreePort(start = CONFIG.webrunPortStart, end = CONFIG.webrunPortEnd) {
  for (let port = start; port <= end; port++) if (await isPortFree(port)) return port;
  throw new Error(`No free port in ${start}-${end}`);
}

/* ============================================================
   FLUTTER
   ============================================================ */
const Flutter = {
  isInstalled() { return hasCommand('flutter'); },
  getVersion() {
    try { return execSync('flutter --version 2>/dev/null | head -1', { encoding: 'utf8', timeout: 15000 }).trim(); }
    catch(_) { return null; }
  },
  getPath() {
    try { return execSync('which flutter', { encoding: 'utf8', timeout: 3000 }).trim(); }
    catch(_) { return null; }
  },
  async install(send) {
    send('\n=== TYN Flutter Installer ===\n');
    return new Promise(resolve => {
      const script = `
set -e
echo "[1/4] Update packages..."
pkg update -y
echo "[2/4] Install dependencies..."
pkg install -y curl wget git openjdk-17
echo "[3/4] Download Flutter installer..."
curl -L https://raw.githubusercontent.com/ImL1s/termux-flutter-wsl/master/install_flutter_complete.sh -o /tmp/install_flutter.sh
chmod +x /tmp/install_flutter.sh
echo "[4/4] Run installer..."
bash /tmp/install_flutter.sh
`;
      const child = spawn('bash', ['-c', script], { cwd: ROOT, env: { ...process.env, TERM: 'xterm-256color' } });
      child.stdout.on('data', d => send(d.toString()));
      child.stderr.on('data', d => send(d.toString()));
      child.on('error', e => resolve({ ok: false, error: e.message }));
      child.on('close', code => {
        if (code === 0) {
          const ok2 = this.isInstalled();
          send(ok2 ? '\n✓ Flutter installed\n' : '\n⚠ Not in PATH\n');
          resolve({ ok: ok2 });
        } else resolve({ ok: false, error: `exit ${code}` });
      });
    });
  },
  async build(appDir, config, send) {
    send('\n=== TYN Flutter Build ===\n');
    const projectDir = path.join(appDir, 'flutter-project');
    const safeName = (config.package || 'app').split('.').pop().replace(/[^a-zA-Z0-9_]/g, '_') || 'app';
    send('[1/5] flutter create...\n');
    const c1 = await this.runCmd(`flutter create --org ${config.package} --project-name ${safeName} --platforms=android "${projectDir}"`, send);
    if (!c1.ok) return { ok: false, error: 'flutter create failed' };
    send('[2/5] Writing lib/main.dart...\n');
    fs.writeFileSync(path.join(projectDir, 'lib', 'main.dart'), this.generateMainDart(config));
    send('[3/5] Adding webview_flutter...\n');
    await this.runCmd(`cd "${projectDir}" && flutter pub add webview_flutter`, send);
    send('[4/5] Patching manifest...\n');
    this.patchManifest(projectDir, config);
    send('[5/5] flutter build apk...\n');
    await this.runCmd(`cd "${projectDir}" && flutter build apk --release --target-platform android-arm64 --no-tree-shake-icons`, send);
    const candidates = [
      path.join(projectDir, 'build', 'app', 'outputs', 'flutter-apk', 'app-release.apk'),
      path.join(projectDir, 'build', 'app', 'outputs', 'flutter-apk', 'app-arm64-v8a-release.apk'),
      path.join(projectDir, 'build', 'app', 'outputs', 'apk', 'release', 'app-release.apk'),
    ];
    let apkPath = null;
    for (const p of candidates) if (fs.existsSync(p) && fs.statSync(p).size > 0) { apkPath = p; break; }
    if (!apkPath) apkPath = findFileRecursive(path.join(projectDir, 'build'), '.apk');
    if (!apkPath) return { ok: false, error: 'APK not produced' };
    const finalApk = path.join(appDir, 'app.apk');
    fs.copyFileSync(apkPath, finalApk);
    const finalSize = fs.statSync(finalApk).size;
    send(`\n✓ APK: ${(finalSize/1024/1024).toFixed(2)} MB\n`);
    return { ok: true, apkPath: finalApk, size: finalSize, method: 'flutter' };
  },
  generateMainDart(config) {
    const urlHandling = config.urlHandling === 'browser' ? 'external' : 'inapp';
    const fullscreen = config.fullscreen ? 'true' : 'false';
    const splashSkip = config.splashSkip ? 'true' : 'false';
    const splashBg = (config.splashBg || '#3f51b5').replace('#','');
    const splashText = (config.splashText || '#ffffff').replace('#','');
    const logoDataUrl = config.logoDataUrl || '';
    const appName = (config.name || 'App').replace(/'/g, "\\'");
    const targetUrl = (config.url || 'https://example.com').replace(/'/g, "\\'");
    return `
import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

void main() { WidgetsFlutterBinding.ensureInitialized(); runApp(const TynApp()); }

class TynApp extends StatelessWidget {
  const TynApp({super.key});
  @override Widget build(BuildContext context) => MaterialApp(
    title: '${appName}', debugShowCheckedModeBanner: false,
    theme: ThemeData(primarySwatch: Colors.indigo),
    home: const SplashPage());
}

class SplashPage extends StatefulWidget {
  const SplashPage({super.key});
  @override State<SplashPage> createState() => _SplashPageState();
}

class _SplashPageState extends State<SplashPage> {
  @override void initState() {
    super.initState();
    Timer(const Duration(seconds: 3), () {
      if (mounted) Navigator.of(context).pushReplacement(
        MaterialPageRoute(builder: (_) => const HomePage()));
    });
  }
  @override Widget build(BuildContext context) => Scaffold(
    backgroundColor: const Color(0xFF${splashBg}),
    body: Stack(children: [
      Center(child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
        ${logoDataUrl ? `
        Container(width: 120, height: 120,
          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(24),
            boxShadow: const [BoxShadow(color: Colors.black26, blurRadius: 16)]),
          clipBehavior: Clip.antiAlias,
          child: Image.memory(base64Decode('${logoDataUrl.split(',')[1] || ''}'), fit: BoxFit.cover)),
        const SizedBox(height: 24),` : ''}
        const Text('${appName}', style: TextStyle(fontSize: 28, fontWeight: FontWeight.bold, color: Color(0xFF${splashText}))),
      ])),
      ${splashSkip ? `Positioned(top: 48, right: 24, child: SafeArea(child: TextButton(
        onPressed: () => Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => const HomePage())),
        child: const Text('Skip ›', style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.bold))))),` : ''}
    ]));
}

class HomePage extends StatefulWidget {
  const HomePage({super.key});
  @override State<HomePage> createState() => _HomePageState();
}
class _HomePageState extends State<HomePage> {
  late final WebViewController _controller;
  @override void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(Colors.white)
      ..setNavigationDelegate(NavigationDelegate(onNavigationRequest: (req) {
        ${urlHandling === 'external' ? `if (!req.url.startsWith('${targetUrl}')) return NavigationDecision.prevent;` : ''}
        return NavigationDecision.navigate;
      }))
      ..loadRequest(Uri.parse('${targetUrl}'));
  }
  @override Widget build(BuildContext context) => Scaffold(body: SafeArea(
    child: ${fullscreen ? 'SizedBox.expand(child: WebViewWidget(controller: _controller))' : 'WebViewWidget(controller: _controller)}' } }))}
`.replace(/\}\} \}\}/g, '}} }');
  },
  patchManifest(projectDir, config) {
    const p = path.join(projectDir, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
    if (!fs.existsSync(p)) return;
    let xml = fs.readFileSync(p, 'utf8');
    const perms = [];
    if (config.permissions?.internet !== false) perms.push('android.permission.INTERNET');
    if (config.permissions?.write) perms.push('android.permission.WRITE_EXTERNAL_STORAGE');
    if (config.permissions?.read) perms.push('android.permission.READ_EXTERNAL_STORAGE');
    if (config.permissions?.camera) perms.push('android.permission.CAMERA');
    if (config.permissions?.location) perms.push('android.permission.ACCESS_FINE_LOCATION');
    if (config.permissions?.audio) perms.push('android.permission.RECORD_AUDIO');
    if (config.permissions?.notification) perms.push('android.permission.POST_NOTIFICATIONS');
    const px = perms.map(p2 => `    <uses-permission android:name="${p2}"/>`).join('\n');
    if (!xml.includes('uses-permission android:name="android.permission.INTERNET"')) {
      xml = xml.replace(/(<manifest[^>]*>)/, `$1\n${px}`);
    }
    if (config.url?.startsWith('http://') && !xml.includes('usesCleartextTraffic')) {
      xml = xml.replace(/<application/, '<application android:usesCleartextTraffic="true"');
    }
    fs.writeFileSync(p, xml);
  },
  runCmd(cmd, send) {
    return new Promise(resolve => {
      const c = spawn('bash', ['-c', cmd], { cwd: ROOT, env: { ...process.env, TERM: 'xterm-256color', LANG: 'en_US.UTF-8' } });
      c.stdout.on('data', d => send(d.toString()));
      c.stderr.on('data', d => send(d.toString()));
      c.on('error', e => resolve({ ok: false, error: e.message }));
      c.on('close', code => resolve({ ok: code === 0, code }));
    });
  }
};

/* ============================================================
   TERMINAL EXECUTOR
   ============================================================ */
function executeCommand(ws, rawCmd, onProc, options = {}) {
  const cmd = mapCommand(rawCmd);
  if (!cmd.trim()) { ws.send(JSON.stringify({ type: 'exit', code: 0 })); return; }
  const cols = options.cols || 120;
  const rows = options.rows || 30;
  const cwd = options.cwd || CONFIG.cwd || process.env.HOME || '/';
  const shell = options.shell || CONFIG.shell || 'bash';
  const term = options.term || CONFIG.termType || 'xterm-256color';
  const customEnv = options.env || {};
  const customPatterns = options.promptPatterns || [];
  const detectYNEnabled = options.detectYN !== false;
  const env = {
    ...process.env, ...customEnv, TERM: term,
    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
    COLORTERM: 'truecolor', FORCE_COLOR: '1'
  };
  const sendOut = data => {
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'out', data }));
    if (detectYNEnabled) {
      const q = detectYN(data, customPatterns);
      if (q) ws.send(JSON.stringify({ type: 'yn-prompt', question: q }));
    }
  };

  if (EXEC_MODE === 'pty') {
    try {
      const p = pty.spawn(shell === 'bash' ? 'bash' : shell, ['-c', cmd], { name: term, cols, rows, cwd, env });
      const w = { write: d => { try { p.write(d); } catch(_){} },
                  kill: s => { try { p.kill(s); } catch(_){} },
                  resize: (c, r) => { try { p.resize(c, r); } catch(_){} } };
      onProc(w);
      p.onData(sendOut);
      p.onExit(({ exitCode }) => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'out', data: `\n[exit: ${exitCode}]\n` }));
          ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
        }
      });
      return;
    } catch(e) { err('pty failed:', e.message); }
  }

  if (EXEC_MODE === 'script') {
    try {
      const c = spawn('script', ['-qfec', cmd, '/dev/null'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      const w = { write: d => { try { c.stdin.write(d); } catch(_){} },
                  kill: s => { try { c.kill(s); } catch(_){} }, resize: () => {} };
      onProc(w);
      c.stdout.on('data', d => sendOut(d.toString()));
      c.stderr.on('data', d => sendOut(d.toString()));
      c.on('close', code => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'out', data: `\n[exit: ${code}]\n` }));
          ws.send(JSON.stringify({ type: 'exit', code }));
        }
      });
      return;
    } catch(e) { err('script failed:', e.message); }
  }

  const c = spawn(shell, ['-lc', cmd], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const w = { write: d => { try { c.stdin.write(d); } catch(_){} },
              kill: s => { try { c.kill(s); } catch(_){} }, resize: () => {} };
  onProc(w);
  c.stdout.on('data', d => sendOut(d.toString()));
  c.stderr.on('data', d => sendOut(d.toString()));
  c.on('close', code => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'out', data: `\n[exit: ${code}]\n` }));
      ws.send(JSON.stringify({ type: 'exit', code }));
    }
  });
}

/* ============================================================
   ZIP EXTRACTOR
   ============================================================ */
function extractZip(zipPath, destDir, logs) {
  if (AdmZip) {
    try { logs.push('  → adm-zip'); const z = new AdmZip(zipPath); z.extractAllTo(destDir, true);
          logs.push(`  ✓ adm-zip (${z.getEntries().length} entries)`); return true;
    } catch(e) { logs.push(`  ✗ adm-zip: ${e.message}`); }
  }
  if (hasUnzip) {
    try { logs.push('  → unzip'); execSync(`unzip -o -q "${zipPath}" -d "${destDir}"`, { stdio: 'ignore', timeout: 120000 });
          logs.push('  ✓ unzip'); return true;
    } catch(e) { logs.push(`  ✗ unzip: ${e.message}`); }
  }
  if (hasTar) {
    try { logs.push('  → tar'); execSync(`tar -xf "${zipPath}" -C "${destDir}" 2>/dev/null`, { stdio: 'ignore', timeout: 120000 });
          logs.push('  ✓ tar'); return true;
    } catch(e) { logs.push(`  ✗ tar: ${e.message}`); }
  }
  if (has7z) {
    try { const b = hasCommand('7z') ? '7z' : '7za'; logs.push('  → 7z');
          execSync(`${b} x -y -o"${destDir}" "${zipPath}"`, { stdio: 'ignore', timeout: 120000 });
          logs.push('  ✓ 7z'); return true;
    } catch(e) { logs.push(`  ✗ 7z: ${e.message}`); }
  }
  logs.push('  ⚠ No extractor. Install: pkg install unzip');
  return false;
}

/* ============================================================
   WEB RUNNER
   ============================================================ */
const webRunners = new Map();

function detectEntryPoint(dir, logs) {
  if (fs.existsSync(path.join(dir, 'index.html'))) { logs.push('> Entry: /index.html'); return '/index.html'; }
  if (fs.existsSync(path.join(dir, 'index.htm')))  { logs.push('> Entry: /index.htm');  return '/index.htm'; }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'index.html'))) {
      logs.push(`> Entry: /${e.name}/index.html`); return `/${e.name}/index.html`;
    }
  }
  const htmlFiles = findFilesRecursive(dir, '.html');
  if (htmlFiles.length) {
    const rel = '/' + path.relative(dir, htmlFiles[0]).replace(/\\/g, '/');
    logs.push(`> Entry: ${rel}`); return rel;
  }
  logs.push('> No HTML — listing'); return '/';
}

async function startWebRunner(files, req) {
  const runId = 'wr_' + crypto.randomBytes(6).toString('hex');
  const dir = path.join(WEBRUN_DIR, runId);
  fs.mkdirSync(dir, { recursive: true });
  const logs = [], fileList = [];
  logs.push(`> Web Runner (${runId})`);
  for (const f of files) {
    const fname = (f.originalname || 'file').replace(/[/\\]/g, '_');
    const fpath = path.join(dir, fname);
    fs.writeFileSync(fpath, f.buffer);
    const sz = f.size < 1024 ? f.size + ' B' : f.size < 1048576 ? (f.size/1024).toFixed(1) + ' KB' : (f.size/1048576).toFixed(2) + ' MB';
    logs.push(`+ ${fname} (${sz})`);
    fileList.push({ name: fname, size: f.size });
    if (/\.zip$/i.test(fname)) {
      logs.push(`> Extract ${fname}...`);
      if (extractZip(fpath, dir, logs)) { try { fs.unlinkSync(fpath); } catch(_){} }
    }
  }
  const entry = detectEntryPoint(dir, logs);
  const port = await findFreePort();
  logs.push(`> Port: ${port}`);

  const sa = express();
  sa.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Range, Accept-Ranges');
    res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  sa.use((req, res, next) => {
    const line = `[${new Date().toISOString().slice(11,19)}] ${req.method} ${req.path}`;
    logs.push(line);
    const r = webRunners.get(runId);
    if (r) r.clients.forEach(s => { try { s({ log: line, level: 'dim' }); } catch(_){} });
    next();
  });
  sa.use(express.static(dir, {
    index: 'index.html',
    setHeaders: (res) => { res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Access-Control-Allow-Origin', '*'); }
  }));
  sa.use((req, res) => {
    const sp = path.join(dir, decodeURIComponent(req.path));
    if (!sp.startsWith(dir)) return res.status(403).send('Forbidden');
    if (fs.existsSync(sp) && fs.statSync(sp).isDirectory()) {
      const items = fs.readdirSync(sp, { withFileTypes: true }).map(e =>
        `<li><a href="${encodeURIComponent(e.name)}${e.isDirectory()?'/':''}">${e.name}${e.isDirectory()?'/':''}</a></li>`).join('');
      return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>TYN · ${req.path}</title>
        <style>body{font-family:system-ui;padding:24px;background:#0f0f14;color:#e5e7eb;max-width:900px;margin:0 auto}
        h1{color:#4dd0e1;font-size:20px}.meta{color:#6b7280;font-size:12px;margin-bottom:16px;font-family:monospace}
        ul{list-style:none;padding:0}li{padding:8px 0;border-bottom:1px solid #1a1a24}
        a{color:#93c5fd;text-decoration:none;font-family:monospace;font-size:13px}a:hover{color:#60a5fa}</style>
        </head><body><h1>📁 ${req.path}</h1><div class="meta">TYN Web Runner · ${runId}</div>
        <ul>${items || '<li style="color:#6b7280">(empty)</li>'}</ul></body></html>`);
    }
    res.status(404).send(`<!DOCTYPE html><body style="font-family:system-ui;padding:24px;background:#0f0f14;color:#e5e7eb;text-align:center;padding-top:80px"><h1 style="color:#f87171;font-size:48px">404</h1><p style="color:#9ca3af;font-family:monospace">${req.path}</p></body></html>`);
  });

  const ss = http.createServer(sa);
  await new Promise((resolve, reject) => { ss.once('error', reject); ss.listen(port, '0.0.0.0', resolve); });
  logs.push(`> Listening on :${port}`);

  const reqHost = (req.headers.host || 'localhost').split(':')[0];
  const publicUrl = `http://${reqHost}:${port}${entry}`;
  webRunners.set(runId, { server: ss, port, dir, logs, clients: new Set(), createdAt: Date.now(), entry, publicUrl, fileList });
  log(`WebRunner ${runId} → :${port}`);
  return { runId, port, url: publicUrl, entry, logs, files: fileList };
}

function stopWebRunner(runId) {
  const r = webRunners.get(runId);
  if (!r) return false;
  r.clients.forEach(s => { try { s({ log: '> stopped', level: 'warn' }); } catch(_){} });
  r.clients.clear();
  try { r.server.close(); } catch(_){}
  setTimeout(() => { try { fs.rmSync(r.dir, { recursive: true, force: true }); } catch(_){} }, 500);
  webRunners.delete(runId);
  log(`WebRunner ${runId} stopped`);
  return true;
}
function stopAllWebRunners() { const ids = [...webRunners.keys()]; ids.forEach(stopWebRunner); return ids.length; }

/* ============================================================
   EXPRESS APP
   ============================================================ */
const app = express();
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Token, Authorization, Range');
  res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200*1024*1024, files: 50 } });

/* ─────────── AUTH MIDDLEWARE (state + API aware) ─────────── */
function auth(req, res, next) {
  if (getServerState() !== 'on') {
    return res.status(503).json({ ok: false, error: 'Bridge is OFF. Enable via tyn.sh' });
  }
  const token = req.headers['x-api-token'] || req.query.token;
  const v = validateApiToken(token);
  if (!v.ok) {
    return res.status(401).json({ ok: false, error: 'Invalid API: ' + v.reason });
  }
  req.api = v.api;
  next();
}

/* ─────────── INDEX (auto-inject FIRST valid token) ─────────── */
function serveIndex(req, res) {
  const htmlPath = path.join(ROOT, INDEX_FILE);
  if (!fs.existsSync(htmlPath)) return res.status(404).send('index.html not found');
  let html = fs.readFileSync(htmlPath, 'utf8');
  const proto = (req.secure || req.headers['x-forwarded-proto'] === 'https') ? 'wss' : 'ws';
  const host = req.headers.host || `localhost:${PORT}`;
  const token = getFirstValidToken();
  html = html.replace(/__TYN_WS_URL__/g, `${proto}://${host}`);
  html = html.replace(/__TYN_TOKEN__/g, token);
  html = html.replace(/__TYN_ENTRY_URL__/g, `http://${host}${BASE_PATH}`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
}

app.get('/', (req, res) => res.redirect(BASE_PATH));
app.get('/index.html', serveIndex);
app.use(express.static(ROOT, { index: false }));

/* ─────────── PUBLIC endpoints (no auth) ─────────── */
app.get('/api/state', (req, res) => {
  res.json({ ok: true, state: getServerState(), version: VERSION, running: true });
});

/* ─────────── PROTECTED endpoints ─────────── */
app.get('/check', auth, (req, res) => {
  res.json({
    ok: true, server: 'TYN Bridge', version: VERSION, port: PORT,
    execMode: EXEC_MODE, hasPty: !!pty, hasScript, hasUnzip, hasTar, has7z, hasAdmZip: !!AdmZip,
    flutterInstalled: Flutter.isInstalled(), flutterVersion: Flutter.getVersion(),
    entry: `http://localhost:${PORT}${BASE_PATH}`, ws: `ws://localhost:${PORT}`,
    token: req.api.token.slice(0, 12) + '...',
    apiLabel: req.api.label, apiExpiresAt: req.api.expiresAt || null,
    uptime: process.uptime(), platform: os.platform(), hostname: os.hostname(),
    webrunners: webRunners.size, nanoFiles: fs.existsSync(NANO_DIR) ? fs.readdirSync(NANO_DIR).length : 0,
    config: { shell: CONFIG.shell, termType: CONFIG.termType, cwd: CONFIG.cwd, port: CONFIG.port },
  });
});

app.get('/api/check', auth, (req, res) => {
  res.json({ ok: true, version: VERSION, port: PORT, execMode: EXEC_MODE,
    flutter: Flutter.isInstalled(), webrunners: webRunners.size, state: getServerState() });
});

app.post('/api/map', auth, (req, res) => res.json({ ok: true, input: req.body.cmd, output: mapCommand(req.body.cmd) }));
app.post('/api/detect-yn', auth, (req, res) => res.json({ ok: true, detected: detectYN(req.body.text, req.body.patterns), text: req.body.text }));

/* ─────────── CONFIG ─────────── */
app.get('/api/config', auth, (req, res) => {
  try {
    const configs = [];
    if (fs.existsSync(CONFIGS_DIR)) fs.readdirSync(CONFIGS_DIR).forEach(id => {
      const p = path.join(CONFIGS_DIR, id, 'config.json');
      if (fs.existsSync(p)) try { configs.push(JSON.parse(fs.readFileSync(p, 'utf8'))); } catch(_){}
    });
    res.json({ ok: true, configs });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/config/:id', auth, (req, res) => {
  const p = path.join(CONFIGS_DIR, req.params.id, 'config.json');
  if (!fs.existsSync(p)) return res.status(404).json({ ok: false, error: 'not found' });
  try { res.json({ ok: true, config: JSON.parse(fs.readFileSync(p, 'utf8')) }); }
  catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/config', auth, (req, res) => {
  try {
    const cfg = req.body;
    const id = cfg.id || 'cfg_' + crypto.randomBytes(6).toString('hex');
    const dir = path.join(CONFIGS_DIR, id);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cfg.id = id; cfg.savedAt = Date.now();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
    res.json({ ok: true, id, config: cfg });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.put('/api/config/:id', auth, (req, res) => {
  try {
    const dir = path.join(CONFIGS_DIR, req.params.id);
    if (!fs.existsSync(dir)) return res.status(404).json({ ok: false, error: 'not found' });
    const cfg = req.body; cfg.id = req.params.id; cfg.savedAt = Date.now();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
    res.json({ ok: true, config: cfg });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.delete('/api/config/:id', auth, (req, res) => {
  const dir = path.join(CONFIGS_DIR, req.params.id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  res.json({ ok: true });
});

/* ─────────── FLUTTER ─────────── */
app.get('/api/flutter/status', auth, (req, res) => {
  const i = Flutter.isInstalled();
  res.json({ ok: true, installed: i, version: i ? Flutter.getVersion() : null, path: i ? Flutter.getPath() : null });
});
app.post('/api/flutter/install', auth, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const send = d => res.write(`data: ${JSON.stringify({ type: 'log', data: d })}\n\n`);
  const sendE = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
  sendE({ type: 'start', message: 'Installing Flutter...' });
  const r = await Flutter.install(send);
  sendE({ type: 'done', ...r });
  res.end();
});
app.post('/api/flutter/build', auth, upload.fields([{ name: 'zip', maxCount: 1 }, { name: 'video', maxCount: 1 }]), async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const sendE = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
  const send = d => sendE({ type: 'log', data: d });
  try {
    if (!Flutter.isInstalled()) { sendE({ type: 'error', message: 'Flutter not installed' }); return res.end(); }
    const config = JSON.parse(req.body.config);
    const appId = 'app_' + crypto.randomBytes(6).toString('hex');
    const appDir = path.join(APPS_DIR, appId);
    fs.mkdirSync(appDir, { recursive: true });
    if (req.files?.zip) fs.writeFileSync(path.join(appDir, 'source.zip'), req.files.zip[0].buffer);
    if (config.logoDataUrl) {
      const b64 = config.logoDataUrl.split(',')[1];
      if (b64) fs.writeFileSync(path.join(appDir, 'logo.png'), Buffer.from(b64, 'base64'));
    }
    sendE({ type: 'start', appId });
    const r = await Flutter.build(appDir, config, send);
    if (r.ok) {
      const meta = { id: appId, name: config.name, package: config.package, version: config.version,
        logoDataUrl: config.logoDataUrl || null, size: r.size, createdAt: Date.now(), status: 'success', method: 'flutter' };
      fs.writeFileSync(path.join(appDir, 'meta.json'), JSON.stringify(meta, null, 2));
      sendE({ type: 'done', ok: true, app: meta, downloadUrl: `/api/download/${appId}?token=${req.api.token}` });
    } else sendE({ type: 'error', message: r.error });
  } catch(e) { sendE({ type: 'error', message: e.message }); }
  res.end();
});

/* ─────────── BUILD (fallback) ─────────── */
app.post('/api/build', auth, upload.fields([{ name: 'zip', maxCount: 1 }, { name: 'video', maxCount: 1 }]), async (req, res) => {
  try {
    const config = JSON.parse(req.body.config);
    const appId = 'app_' + crypto.randomBytes(6).toString('hex');
    const appDir = path.join(APPS_DIR, appId);
    fs.mkdirSync(appDir, { recursive: true });
    if (req.files?.zip) fs.writeFileSync(path.join(appDir, 'source.zip'), req.files.zip[0].buffer);
    if (req.files?.video) fs.writeFileSync(path.join(appDir, 'splash.mp4'), req.files.video[0].buffer);
    if (config.logoDataUrl) {
      const b64 = config.logoDataUrl.split(',')[1];
      if (b64) fs.writeFileSync(path.join(appDir, 'logo.png'), Buffer.from(b64, 'base64'));
    }
    let br;
    if (Flutter.isInstalled()) br = await Flutter.build(appDir, config, () => {});
    else br = createFallbackApk(appDir, config);
    const meta = { id: appId, name: config.name, package: config.package, version: config.version,
      logoDataUrl: config.logoDataUrl || null, size: br.size || 0, createdAt: Date.now(),
      status: br.ok ? 'success' : 'error', error: br.error || null, method: br.method };
    fs.writeFileSync(path.join(appDir, 'meta.json'), JSON.stringify(meta, null, 2));
    if (!br.ok) return res.status(500).json({ ok: false, error: br.error, app: meta });
    res.json({ ok: true, app: meta, downloadUrl: `/api/download/${appId}?token=${req.api.token}` });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
function createFallbackApk(appDir, config) {
  const p = path.join(appDir, 'app.apk');
  fs.writeFileSync(p, Buffer.from('PK\x03\x04TYN-FALLBACK\n' + JSON.stringify({ warning: 'Install Flutter for real APK', config: { name: config.name, package: config.package } })));
  return { ok: true, apkPath: p, size: fs.statSync(p).size, method: 'fallback' };
}

/* ─────────── DOWNLOAD ─────────── */
app.get('/api/download/:id', auth, async (req, res) => {
  const apk = path.join(APPS_DIR, req.params.id, 'app.apk');
  let ready = false;
  for (let i = 0; i < 20; i++) { if (fs.existsSync(apk)) { ready = true; break; } await sleep(500); }
  if (!ready) return res.status(404).json({ ok: false, error: 'APK not found' });
  let stat = null;
  for (let i = 0; i < 10; i++) { try { stat = fs.statSync(apk); } catch(_){} if (stat && stat.size > 0) break; await sleep(500); }
  if (!stat || stat.size === 0) return res.status(425).json({ ok: false, error: 'APK 0 bytes' });
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}.apk"`);
  res.setHeader('Accept-Ranges', 'bytes');
  const s = fs.createReadStream(apk);
  s.on('error', e => { if (!res.headersSent) res.status(500).json({ ok: false, error: e.message }); else res.destroy(); });
  s.pipe(res);
});

/* ─────────── BUILD STATUS / APPS ─────────── */
app.get('/api/build/status/:id', auth, (req, res) => {
  const mp = path.join(APPS_DIR, req.params.id, 'meta.json');
  const ap = path.join(APPS_DIR, req.params.id, 'app.apk');
  if (!fs.existsSync(mp)) return res.json({ ok: false, status: 'not_found' });
  let meta; try { meta = JSON.parse(fs.readFileSync(mp, 'utf8')); } catch(_) { return res.json({ ok: false, status: 'invalid_meta' }); }
  let sz = 0, rdy = false;
  if (fs.existsSync(ap)) { sz = fs.statSync(ap).size; rdy = sz > 0; }
  res.json({ ok: true, id: req.params.id, meta, apkReady: rdy, apkSize: sz,
    downloadUrl: rdy ? `/api/download/${req.params.id}?token=${req.api.token}` : null });
});
app.get('/api/apps', auth, (req, res) => {
  try {
    const apps = [];
    if (fs.existsSync(APPS_DIR)) fs.readdirSync(APPS_DIR).forEach(id => {
      const mp = path.join(APPS_DIR, id, 'meta.json');
      if (fs.existsSync(mp)) try {
        const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
        const ap = path.join(APPS_DIR, id, 'app.apk');
        m.apkSize = fs.existsSync(ap) ? fs.statSync(ap).size : 0;
        m.apkReady = m.apkSize > 0;
        apps.push(m);
      } catch(_){}
    });
    res.json({ ok: true, apps });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.delete('/api/apps/:id', auth, (req, res) => {
  const d = path.join(APPS_DIR, req.params.id);
  if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  res.json({ ok: true });
});

/* ─────────── WEB RUNNER ─────────── */
app.post('/api/webrun/start', auth, upload.fields([{ name: 'files', maxCount: 50 }]), async (req, res) => {
  try {
    const files = req.files?.files || [];
    if (!files.length) return res.status(400).json({ ok: false, error: 'No files' });
    const r = await startWebRunner(files, req);
    res.json({ ok: true, ...r });
  } catch(e) { err('WebRunner:', e.message); res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/webrun/logs/:runId', auth, (req, res) => {
  const r = webRunners.get(req.params.runId);
  if (!r) return res.status(404).json({ ok: false, error: 'not found' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const send = o => { try { res.write(`data: ${JSON.stringify(o)}\n\n`); } catch(_){} };
  send({ log: `> Connected`, level: 'info' });
  r.logs.forEach(l => send({ log: l, level: 'dim' }));
  r.clients.add(send);
  const ka = setInterval(() => send({ log: '', level: 'heartbeat' }), 25000);
  req.on('close', () => { clearInterval(ka); r.clients.delete(send); });
});
app.post('/api/webrun/stop/:runId', auth, (req, res) => res.json({ ok: true, stopped: stopWebRunner(req.params.runId) }));
app.get('/api/webrun/list', auth, (req, res) => {
  const list = [...webRunners.entries()].map(([id, r]) => ({
    runId: id, port: r.port, entry: r.entry, publicUrl: r.publicUrl,
    createdAt: r.createdAt, clients: r.clients.size, files: r.fileList.length,
  }));
  res.json({ ok: true, runners: list });
});
app.get('/api/webrun/status/:runId', auth, (req, res) => {
  const r = webRunners.get(req.params.runId);
  if (!r) return res.json({ ok: false, status: 'not_found' });
  res.json({ ok: true, status: 'running', runId: req.params.runId, port: r.port,
    entry: r.entry, publicUrl: r.publicUrl, uptime: Date.now() - r.createdAt,
    files: r.fileList, logCount: r.logs.length });
});

/* ─────────── NANO ─────────── */
app.post('/api/nano/save', auth, express.json({ limit: '10mb' }), (req, res) => {
  try {
    const { filename, content } = req.body || {};
    if (!filename || typeof content !== 'string') return res.status(400).json({ ok: false, error: 'invalid' });
    const safe = String(filename).replace(/[/\\]/g, '_').replace(/^\.+/, '');
    if (!safe) return res.status(400).json({ ok: false, error: 'invalid filename' });
    const p = path.join(NANO_DIR, safe);
    fs.writeFileSync(p, content, 'utf8');
    res.json({ ok: true, path: path.relative(ROOT, p), size: fs.statSync(p).size, filename: safe });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/nano/files', auth, (req, res) => {
  try {
    const files = fs.existsSync(NANO_DIR)
      ? fs.readdirSync(NANO_DIR).filter(f => { try { return fs.statSync(path.join(NANO_DIR, f)).isFile(); } catch(_) { return false; } })
          .map(f => { const st = fs.statSync(path.join(NANO_DIR, f)); return { name: f, size: st.size, mtime: st.mtimeMs }; })
      : [];
    res.json({ ok: true, files });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/nano/get/:filename', auth, (req, res) => {
  try {
    const safe = String(req.params.filename).replace(/[/\\]/g, '_').replace(/^\.+/, '');
    const p = path.join(NANO_DIR, safe);
    if (!fs.existsSync(p)) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, filename: safe, content: fs.readFileSync(p, 'utf8') });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.delete('/api/nano/:filename', auth, (req, res) => {
  try {
    const safe = String(req.params.filename).replace(/[/\\]/g, '_').replace(/^\.+/, '');
    const p = path.join(NANO_DIR, safe);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

/* ============================================================
   WEBSOCKET
   ============================================================ */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/term' });
const activeSessions = new Map();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  const session = url.searchParams.get('session') || 'default';

  // Check state first
  if (getServerState() !== 'on') {
    ws.send(JSON.stringify({ type: 'error', data: 'Bridge is OFF. Enable via tyn.sh' }));
    ws.close(); return;
  }
  const v = validateApiToken(token);
  if (!v.ok) {
    ws.send(JSON.stringify({ type: 'error', data: 'Invalid API: ' + v.reason }));
    ws.close(); return;
  }

  log(`Terminal: ${session} @ ${req.socket.remoteAddress}`);
  activeSessions.set(session, { ws, connectedAt: Date.now() });
  ws.send(JSON.stringify({
    type: 'out',
    data: `* ${VERSION_FULL} connected\n* session: ${session}\n* exec: ${EXEC_MODE}\n* shell: ${CONFIG.shell} (term: ${CONFIG.termType})\n* ync → pkg\n* api: ${v.api.label || 'n/a'}\n* webrunners: ${webRunners.size}\n`
  }));

  let runningProc = null;
  let sessionConfig = {};

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      switch (msg.type) {
        case 'exec':
          if (runningProc) { try { runningProc.kill(); } catch(_){} runningProc = null; }
          executeCommand(ws, msg.cmd, p => { runningProc = p; }, {
            cols: msg.cols || 120, rows: msg.rows || 30,
            cwd: msg.cwd || sessionConfig?.terminal?.cwd || CONFIG.cwd,
            shell: msg.shell || sessionConfig?.terminal?.shell || CONFIG.shell,
            term: msg.term || sessionConfig?.terminal?.term || CONFIG.termType,
            env: sessionConfig?.advanced?.env || {},
            promptPatterns: sessionConfig?.behavior?.promptPatterns || [],
            detectYN: sessionConfig?.behavior?.detectYN !== false,
          });
          break;
        case 'input': if (runningProc?.write) runningProc.write(msg.data); break;
        case 'kill': if (runningProc) { try { runningProc.kill(msg.signal || 'SIGINT'); } catch(_){} } break;
        case 'resize': if (runningProc?.resize) runningProc.resize(msg.cols || 120, msg.rows || 30); break;
        case 'config': sessionConfig = msg.config || {}; ws.send(JSON.stringify({ type: 'config-ack', ok: true })); break;
        case 'ping': ws.send(JSON.stringify({ type: 'pong', ts: Date.now() })); break;
        case 'yn-answer':
          if (runningProc?.write) {
            runningProc.write((msg.answer || 'y') + '\n');
            ws.send(JSON.stringify({ type: 'out', data: `${msg.answer || 'y'}\n` }));
          }
          break;
        default: ws.send(JSON.stringify({ type: 'error', data: 'Unknown: ' + msg.type }));
      }
    } catch(e) { ws.send(JSON.stringify({ type: 'error', data: 'Bad msg: ' + e.message })); }
  });

  ws.on('close', () => {
    if (runningProc) { try { runningProc.kill(); } catch(_){} }
    activeSessions.delete(session);
    log(`Terminal closed: ${session}`);
  });
  ws.on('error', e => err(`WS error: ${e.message}`));
});

/* ============================================================
   START
   ============================================================ */
server.listen(PORT, HOST, () => {
  const ifaces = os.networkInterfaces();
  const addrs = [];
  Object.values(ifaces).forEach(l => l.forEach(i => {
    if (i.family === 'IPv4' && !i.internal) addrs.push(i.address);
  }));
  const APIs = loadApis().apis || [];
  const validCount = APIs.filter(a => !a.revoked && (!a.expiresAt || a.expiresAt > Date.now())).length;
  const state = getServerState();

  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log(`║   ${VERSION_FULL.padEnd(56)}║`);
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log(`║ Entry  : http://localhost:${PORT}/index.html`.padEnd(60) + '║');
  addrs.forEach(a => console.log(`║ Remote : http://${a}:${PORT}/index.html`.padEnd(60) + '║'));
  console.log(`║ WS     : ws://localhost:${PORT}/term`.padEnd(60) + '║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log(`║ State            : ${state === 'on' ? '✓ ON' : '○ OFF (via tyn.sh)'}`.padEnd(60) + '║');
  console.log(`║ APIs valid/total : ${validCount}/${APIs.length}`.padEnd(60) + '║');
  console.log(`║ Shell / TERM     : ${CONFIG.shell} / ${CONFIG.termType}`.padEnd(60) + '║');
  console.log(`║ CWD              : ${CONFIG.cwd}`.padEnd(60) + '║');
  console.log(`║ Exec mode        : ${EXEC_MODE}`.padEnd(60) + '║');
  console.log(`║ node-pty         : ${pty ? '✓' : '✗'}`.padEnd(60) + '║');
  console.log(`║ Flutter          : ${Flutter.isInstalled() ? '✓' : '✗'}`.padEnd(60) + '║');
  console.log(`║ Web Runner       : :${CONFIG.webrunPortStart}-${CONFIG.webrunPortEnd}`.padEnd(60) + '║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log('║ 💡 Manage state, APIs, config from tyn.sh                 ║');
  if (state !== 'on') {
    console.log('║ ⚠ State OFF — HTML accessible, WS/API disabled            ║');
    console.log('║   Enable: bash tyn.sh → [1]                              ║');
  }
  if (validCount === 0) {
    console.log('║ ⚠ No valid APIs — generate: bash tyn.sh → [6]            ║');
  }
  console.log('╚═══════════════════════════════════════════════════════════╝');
});

/* ============================================================
   SHUTDOWN
   ============================================================ */
function shutdown(sig) {
  console.log(`\n[TYN] ${sig} — shutting down...`);
  const n = stopAllWebRunners();
  if (n) log(`Stopped ${n} runners`);
  activeSessions.forEach(({ ws }) => { try { ws.close(); } catch(_){} });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', e => err('Uncaught:', e));
process.on('unhandledRejection', e => err('Unhandled:', e));