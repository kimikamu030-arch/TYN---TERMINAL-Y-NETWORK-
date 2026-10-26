#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════╗
# ║  TYN — Terminal Y Network                                            ║
# ║  Bridge Manager Shell Wrapper                                        ║
# ║  Version: 1.0.0-beta                                                 ║
# ╚══════════════════════════════════════════════════════════════════════╝
#
# Managed files:
#   apis.json     — API tokens with expiry (managed via menu)
#   config.json   — shell/term/cwd/port/host
#   server.state  — "on" | "off" | "killed"
#   .server.pid   — node process PID
#
# Behavior:
#   - Enable Bridge    → state=on  → WS/API enabled (needs valid API)
#   - Disable Bridge   → state=off → HTML still accessible, WS/API rejected
#   - Full Shutdown    → state=killed → node process terminated
#
set -u

# ─────────────────────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────────────────────
TYN_VERSION="1.0.0-beta"
TYN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APIS_FILE="$TYN_DIR/apis.json"
CONFIG_FILE="$TYN_DIR/config.json"
STATE_FILE="$TYN_DIR/server.state"
PID_FILE="$TYN_DIR/.server.pid"
LOG_FILE="$TYN_DIR/bridge.log"
BRIDGE_JS="$TYN_DIR/bridge.js"

# ─────────────────────────────────────────────────────────────────────────
# COLORS
# ─────────────────────────────────────────────────────────────────────────
R='\033[0m'; B='\033[1m'; D='\033[2m'
RED='\033[31m'; GRN='\033[32m'; YEL='\033[33m'
BLU='\033[34m'; MAG='\033[35m'; CYN='\033[36m'; WHT='\033[37m'

# ─────────────────────────────────────────────────────────────────────────
# UTIL
# ─────────────────────────────────────────────────────────────────────────
pause() { read -r -p "Press ENTER to continue..." _ 2>/dev/null || sleep 2; }
err() { echo -e "${RED}✗ $*${R}"; }
ok() { echo -e "${GRN}✓ $*${R}"; }
info() { echo -e "${CYN}ℹ $*${R}"; }
warn() { echo -e "${YEL}⚠ $*${R}"; }
have_node() { command -v node >/dev/null 2>&1; }

banner() {
  clear 2>/dev/null || printf '\033[2J\033[H'
  printf "${CYN}${B}"
  cat <<'ASCII'

  ████████╗██╗   ██╗███╗   ██╗
  ╚══██╔══╝╚██╗ ██╔╝████╗  ██║
     ██║    ╚████╔╝ ██╔██╗ ██║
     ██║     ╚██╔╝  ██║╚██╗██║
     ██║      ██║   ██║ ╚████║
     ╚═╝      ╚═╝   ╚═╝  ╚═══╝

ASCII
  printf "${R}\n"
  printf "${MAG}${B}      T E R M I N A L   Y   N E T W O R K${R}\n"
  printf "${D}                     v${TYN_VERSION}${R}\n"
  printf "${D}   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${R}\n"
}

# ─────────────────────────────────────────────────────────────────────────
# INIT FILES
# ─────────────────────────────────────────────────────────────────────────
init_files() {
  [ -f "$APIS_FILE" ] || echo '{"apis":[]}' > "$APIS_FILE"
  if [ ! -f "$CONFIG_FILE" ]; then
    cat > "$CONFIG_FILE" <<'JSON'
{
  "shell": "bash",
  "termType": "xterm-256color",
  "cwd": "~",
  "port": 7700,
  "host": "0.0.0.0",
  "webrunPortStart": 8080,
  "webrunPortEnd": 8200
}
JSON
  fi
  [ -f "$STATE_FILE" ] || echo "off" > "$STATE_FILE"
}

# ─────────────────────────────────────────────────────────────────────────
# JSON HELPERS
# ─────────────────────────────────────────────────────────────────────────
json_get() {
  node -e '
    try {
      const d = JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
      process.stdout.write(String(eval(process.argv[2]) ?? ""));
    } catch(e) { process.stdout.write(""); }
  ' "$1" "$2"
}

json_set() {
  node -e '
    const fs=require("fs");const f=process.argv[1];
    const d=JSON.parse(fs.readFileSync(f,"utf8"));
    eval(process.argv[2]);
    fs.writeFileSync(f,JSON.stringify(d,null,2));
  ' "$1" "$2"
}

# ─────────────────────────────────────────────────────────────────────────
# STATE
# ─────────────────────────────────────────────────────────────────────────
get_state() { [ -f "$STATE_FILE" ] && tr -d '\n\r ' < "$STATE_FILE" || echo "off"; }
set_state() { echo "$1" > "$STATE_FILE"; }

is_node_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid; pid=$(tr -d '\n\r ' < "$PID_FILE")
  [ -z "$pid" ] && return 1
  if kill -0 "$pid" 2>/dev/null; then return 0; fi
  rm -f "$PID_FILE"; return 1
}

start_node_process() {
  is_node_running && { info "Node already running (PID $(cat "$PID_FILE"))"; return 0; }
  have_node || { err "Node.js not installed"; return 1; }
  [ -f "$BRIDGE_JS" ] || { err "bridge.js not found"; return 1; }
  info "Starting node..."
  nohup node "$BRIDGE_JS" >> "$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"
  sleep 1
  if kill -0 "$pid" 2>/dev/null; then
    ok "Node started (PID $pid)"
  else
    err "Failed to start. Check $LOG_FILE"
    rm -f "$PID_FILE"; return 1
  fi
}

stop_node_process() {
  is_node_running || { info "Node not running"; rm -f "$PID_FILE"; return 0; }
  local pid; pid=$(cat "$PID_FILE")
  info "Stopping node (PID $pid)..."
  kill "$pid" 2>/dev/null || true
  sleep 1
  kill -0 "$pid" 2>/dev/null && { warn "Force killing"; kill -9 "$pid" 2>/dev/null; }
  rm -f "$PID_FILE"
  ok "Node stopped"
}

# ─────────────────────────────────────────────────────────────────────────
# API
# ─────────────────────────────────────────────────────────────────────────
gen_token() { node -e 'console.log("tyn_"+require("crypto").randomBytes(20).toString("hex"))'; }

generate_api() {
  have_node || return 1
  echo ""
  echo -e "${B}Generate Trial API${R}"
  echo "─────────────────────────────────────"
  echo "  1) 1 hour      4) 7 days"
  echo "  2) 6 hours     5) 30 days"
  echo "  3) 1 day       6) Never expire"
  echo "  0) Cancel"
  echo ""
  read -r -p "Duration: " c
  local sec label
  case "$c" in
    1) sec=3600;    label="1 hour"   ;;
    2) sec=21600;   label="6 hours"  ;;
    3) sec=86400;   label="1 day"    ;;
    4) sec=604800;  label="7 days"   ;;
    5) sec=2592000; label="30 days"  ;;
    6) sec=0;       label="Never"    ;;
    0|*) info "Cancelled"; return 0 ;;
  esac
  local token now expires
  token=$(gen_token)
  now=$(node -e 'console.log(Date.now())')
  if [ "$sec" -eq 0 ]; then expires=0; else expires=$((now + sec*1000)); fi
  node -e '
    const fs=require("fs");const f=process.argv[1];
    const [tok,label,now,exp]=process.argv.slice(2);
    const d=JSON.parse(fs.readFileSync(f,"utf8"));
    d.apis=d.apis||[];
    d.apis.push({token:tok,label:"Trial "+label,duration:label,createdAt:+now,expiresAt:+exp,revoked:false});
    fs.writeFileSync(f,JSON.stringify(d,null,2));
  ' "$APIS_FILE" "$token" "$label" "$now" "$expires"
  echo ""
  ok "API generated"
  echo -e "  ${B}Token:${R} ${YEL}$token${R}"
  echo -e "  ${D}Duration: $label${R}"
  if [ "$expires" -ne 0 ]; then
    echo -e "  ${D}Expires: $(date -d "@$((expires/1000))" 2>/dev/null || echo "$expires")${R}"
  else
    echo -e "  ${D}Expires: never${R}"
  fi
  echo ""
  pause
}

list_apis() {
  have_node || return 1
  node -e '
    const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    const apis=d.apis||[];
    const now=Date.now();
    const R="\x1b[0m",G="\x1b[32m",Y="\x1b[33m",Re="\x1b[31m",D="\x1b[2m";
    if(!apis.length){console.log("\n  (no APIs yet)\n");process.exit(0);}
    console.log("");
    console.log("  #   Token                              Status     Expires");
    console.log("  ──────────────────────────────────────────────────────────");
    apis.forEach((a,i)=>{
      let s,col;
      if(a.revoked){s="revoked";col=Re;}
      else if(a.expiresAt&&now>a.expiresAt){s="expired";col=Y;}
      else{s="active";col=G;}
      let exp="never";
      if(a.expiresAt){const dt=new Date(a.expiresAt);exp=dt.toISOString().slice(0,10)+" "+dt.toISOString().slice(11,16);}
      console.log(`  ${String(i+1).padStart(2)}  ${(a.token||"").slice(0,34)} ${col}${s.padEnd(10)}${R} ${D}${exp}${R}`);
    });
    console.log("");
  ' "$APIS_FILE"
  pause
}

revoke_api() {
  have_node || return 1
  node -e '
    const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    (d.apis||[]).forEach((a,i)=>console.log(`  [${i+1}] ${a.token}  ${a.revoked?"(REVOKED)":""}`));
  ' "$APIS_FILE"
  echo ""
  read -r -p "Revoke # (0=cancel): " idx
  [ "$idx" = "0" ] || [ -z "$idx" ] && return 0
  node -e '
    const fs=require("fs");const f=process.argv[1];const i=+process.argv[2];
    const d=JSON.parse(fs.readFileSync(f,"utf8"));
    if(i>=1&&i<=(d.apis||[]).length){d.apis[i-1].revoked=true;fs.writeFileSync(f,JSON.stringify(d,null,2));}
  ' "$APIS_FILE" "$idx"
  ok "Revoked"
  pause
}

# ─────────────────────────────────────────────────────────────────────────
# SERVER CONTROL
# ─────────────────────────────────────────────────────────────────────────
server_status() {
  echo ""
  echo -e "${B}Status${R}"
  echo "───────────────────────────────────"
  if is_node_running; then
    echo -e "  Node    : ${GRN}RUNNING${R} (PID $(cat "$PID_FILE"))"
  else
    echo -e "  Node    : ${RED}STOPPED${R}"
  fi
  case "$(get_state)" in
    on)     echo -e "  State   : ${GRN}ON${R} (full functionality)" ;;
    off)    echo -e "  State   : ${YEL}OFF${R} (HTML only, WS/API disabled)" ;;
    killed) echo -e "  State   : ${RED}KILLED${R}" ;;
    *)      echo -e "  State   : ?" ;;
  esac
  [ -f "$CONFIG_FILE" ] && {
    echo -e "  Shell   : $(json_get "$CONFIG_FILE" d.shell)"
    echo -e "  TERM    : $(json_get "$CONFIG_FILE" d.termType)"
    echo -e "  Port    : $(json_get "$CONFIG_FILE" d.port)"
  }
  if have_node; then
    local vc tc
    vc=$(node -e '
      const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
      const now=Date.now();
      console.log((d.apis||[]).filter(a=>!a.revoked&&(!a.expiresAt||a.expiresAt>now)).length);
    ' "$APIS_FILE" 2>/dev/null)
    tc=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((d.apis||[]).length);' "$APIS_FILE" 2>/dev/null)
    echo -e "  APIs    : $vc valid / $tc total"
  fi
  echo ""
  pause
}

server_on() {
  have_node || return 1
  echo ""
  echo -e "${B}Enable Bridge${R}"
  echo "───────────────────────────────────"
  echo "Enter API token (empty = first valid API):"
  read -r -p "Token: " input
  local token
  if [ -z "$input" ]; then
    token=$(node -e '
      const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
      const now=Date.now();
      const v=(d.apis||[]).find(a=>!a.revoked&&(!a.expiresAt||a.expiresAt>now));
      process.stdout.write(v?v.token:"");
    ' "$APIS_FILE")
    [ -z "$token" ] && { err "No valid API. Generate first."; pause; return 1; }
    info "Using: ${token:0:16}..."
  else
    token="$input"
  fi
  local v
  v=$(node -e '
    const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    const a=(d.apis||[]).find(x=>x.token===process.argv[2]);
    const now=Date.now();
    if(!a) console.log("no:not_found");
    else if(a.revoked) console.log("no:revoked");
    else if(a.expiresAt&&a.expiresAt<now) console.log("no:expired");
    else console.log("yes");
  ' "$APIS_FILE" "$token")
  [ "$v" != "yes" ] && { err "API rejected: $v"; pause; return 1; }
  is_node_running || start_node_process || { pause; return 1; }
  set_state "on"
  ok "Bridge is ON"
  echo -e "${CYN}Open: http://localhost:$(json_get "$CONFIG_FILE" d.port)/index.html${R}"
  echo ""
  pause
}

server_off() {
  set_state "off"
  ok "State: OFF"
  echo -e "${D}Node still running. /index.html accessible. WS/API rejected.${R}"
  pause
}

server_restart() {
  is_node_running && stop_node_process
  [ "$(get_state)" = "killed" ] && set_state "off"
  start_node_process && ok "Restarted"
  pause
}

server_kill() {
  echo -e "${RED}${B}Full Shutdown${R}"
  echo "This kills the node process. HTML stops working."
  read -r -p "Confirm [y/N]: " c
  case "$c" in y|Y) ;; *) info "Cancelled"; return 0 ;; esac
  stop_node_process
  set_state "killed"
  ok "Killed"
  pause
}

# ─────────────────────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────────────────────
show_config() {
  echo ""
  echo -e "${B}Current Config${R}"
  echo "───────────────────────────────────"
  node -e '
    const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    Object.entries(d).forEach(([k,v])=>console.log(`  ${k.padEnd(18)}: ${v}`));
  ' "$CONFIG_FILE"
}

config_menu() {
  while true; do
    banner
    show_config
    echo ""
    echo "  [1] Shell    (bash/sh/zsh/fish)"
    echo "  [2] TERM     (xterm-256color/xterm/screen/vt100)"
    echo "  [3] CWD      (default: ~)"
    echo "  [4] Port     (default: 7700)"
    echo "  [5] Host     (default: 0.0.0.0)"
    echo "  [6] Web Runner ports"
    echo "  [0] Back"
    echo ""
    read -r -p "Choice: " c
    case "$c" in
      1)
        echo "  [1]bash [2]sh [3]zsh [4]fish"
        read -r -p "→ " s
        case "$s" in
          1) json_set "$CONFIG_FILE" 'd.shell="bash"'; ok "bash" ;;
          2) json_set "$CONFIG_FILE" 'd.shell="sh"'; ok "sh" ;;
          3) json_set "$CONFIG_FILE" 'd.shell="zsh"'; ok "zsh" ;;
          4) json_set "$CONFIG_FILE" 'd.shell="fish"'; ok "fish" ;;
        esac
        ;;
      2)
        echo "  [1]xterm-256color [2]xterm [3]screen-256color [4]vt100"
        read -r -p "→ " s
        case "$s" in
          1) json_set "$CONFIG_FILE" 'd.termType="xterm-256color"'; ok ;;
          2) json_set "$CONFIG_FILE" 'd.termType="xterm"'; ok ;;
          3) json_set "$CONFIG_FILE" 'd.termType="screen-256color"'; ok ;;
          4) json_set "$CONFIG_FILE" 'd.termType="vt100"'; ok ;;
        esac
        ;;
      3)
        read -r -p "CWD: " d
        [ -n "$d" ] && json_set "$CONFIG_FILE" "d.cwd=\"$d\"" && ok
        ;;
      4)
        read -r -p "Port: " p
        if [[ "$p" =~ ^[0-9]+$ ]] && [ "$p" -ge 1 ] && [ "$p" -le 65535 ]; then
          json_set "$CONFIG_FILE" "d.port=$p"; ok "Set $p (restart needed)"
        else err "Invalid"; fi
        ;;
      5)
        read -r -p "Host: " h
        [ -n "$h" ] && json_set "$CONFIG_FILE" "d.host=\"$h\"" && ok
        ;;
      6)
        read -r -p "Start: " a
        read -r -p "End: " b
        [[ "$a" =~ ^[0-9]+$ ]] && [[ "$b" =~ ^[0-9]+$ ]] \
          && json_set "$CONFIG_FILE" "d.webrunPortStart=$a; d.webrunPortEnd=$b" && ok
        ;;
      0|"") return ;;
    esac
    pause
  done
}

# ─────────────────────────────────────────────────────────────────────────
# ADVANCED
# ─────────────────────────────────────────────────────────────────────────
check_deps() {
  echo ""
  echo -e "${B}Dependencies${R}"
  echo "───────────────────────────────────"
  for cmd in node npm bash; do
    if command -v "$cmd" >/dev/null 2>&1; then
      printf "  %-8s ${GRN}✓${R} %s\n" "$cmd" "$(command -v $cmd)"
    else
      printf "  %-8s ${RED}✗${R} not found\n" "$cmd"
    fi
  done
  for pkg in express ws multer node-pty adm-zip; do
    if node -e "require('$pkg')" 2>/dev/null; then
      printf "  %-8s ${GRN}✓${R}\n" "$pkg"
    else
      printf "  %-8s ${YEL}○${R}\n" "$pkg"
    fi
  done
}

advanced_menu() {
  while true; do
    banner
    echo -e "${B}Advanced Functions${R}"
    echo "───────────────────────────────────"
    echo "  [1] Check dependencies"
    echo "  [2] Install npm dependencies"
    echo "  [3] View logs (tail -f)"
    echo "  [4] Clear logs"
    echo "  [5] Cleanup runtime dirs"
    echo "  [6] Backup config + APIs"
    echo "  [7] Restore backup"
    echo "  [8] Show files"
    echo "  [9] Reset everything"
    echo "  [0] Back"
    echo ""
    read -r -p "Choice: " c
    case "$c" in
      1) check_deps; pause ;;
      2) install_deps; pause ;;
      3) [ -f "$LOG_FILE" ] && { info "Ctrl+C to stop"; tail -f "$LOG_FILE"; } || { warn "no log"; pause; } ;;
      4) [ -f "$LOG_FILE" ] && > "$LOG_FILE" && ok "cleared"; pause ;;
      5) rm -rf "$TYN_DIR/runtime" "$TYN_DIR/logs"; mkdir -p "$TYN_DIR/runtime" "$TYN_DIR/logs"; ok "cleaned"; pause ;;
      6)
        local out="$TYN_DIR/backup_$(date +%Y%m%d_%H%M%S).tar.gz"
        tar -czf "$out" -C "$TYN_DIR" apis.json config.json server.state 2>/dev/null
        ok "$out"; pause
        ;;
      7)
        ls -1 "$TYN_DIR"/backup_*.tar.gz 2>/dev/null || { warn "none"; pause; return; }
        read -r -p "File: " f
        [ -f "$f" ] && tar -xzf "$f" -C "$TYN_DIR" && ok "restored" || err "not found"
        pause
        ;;
      8) cd "$TYN_DIR" && find . -maxdepth 2 -not -path '*/node_modules/*' | sort | head -40; pause ;;
      9)
        echo -e "${RED}Reset everything?${R} Type YES:"
        read -r c2
        [ "$c2" = "YES" ] || { info "cancelled"; return; }
        stop_node_process
        rm -f "$APIS_FILE" "$CONFIG_FILE" "$STATE_FILE" "$PID_FILE"
        rm -rf "$TYN_DIR/runtime" "$TYN_DIR/nano" "$TYN_DIR/logs"
        init_files
        ok "reset"; pause
        ;;
      0|"") return ;;
    esac
  done
}

install_deps() {
  info "Installing express ws multer..."
  cd "$TYN_DIR" && npm install express ws multer --save 2>&1 | tail -5
  read -r -p "Also install node-pty adm-zip? [y/N]: " c
  case "$c" in y|Y) npm install node-pty adm-zip --save 2>&1 | tail -5 ;; esac
  ok "done"
}

# ─────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────
status_line() {
  local st nst
  st=$(get_state)
  if is_node_running; then nst="${GRN}●${R} PID $(cat "$PID_FILE")"; else nst="${RED}○${R}"; fi
  case "$st" in
    on) st="${GRN}ON${R}" ;; off) st="${YEL}OFF${R}" ;; killed) st="${RED}KILLED${R}" ;;
  esac
  echo -e "${D}  Node: $nst   State: $st${R}"
}

main_menu() {
  while true; do
    banner
    status_line
    echo ""
    echo -e "${B}Main Menu${R}"
    echo "─────────────────────────────────────────"
    echo "  ${GRN}[1]${R} Enable Bridge   (needs API)"
    echo "  ${YEL}[2]${R} Disable Bridge  (HTML still works)"
    echo "  ${CYN}[3]${R} Restart Node"
    echo "  ${RED}[4]${R} Full Shutdown   (kill everything)"
    echo "  ${BLU}[5]${R} Status"
    echo "  ──────────────────────────────────────"
    echo "  ${MAG}[6]${R} Generate API (Trial)"
    echo "  ${MAG}[7]${R} List APIs"
    echo "  ${MAG}[8]${R} Revoke API"
    echo "  ${CYN}[9]${R} Config"
    echo "  ${WHT}[A]${R} Advanced"
    echo "  ${D}[0] Exit${R}"
    echo ""
    read -r -p "Choice: " c
    case "$c" in
      1) server_on ;;
      2) server_off ;;
      3) server_restart ;;
      4) server_kill ;;
      5) server_status ;;
      6) generate_api ;;
      7) list_apis ;;
      8) revoke_api ;;
      9) config_menu ;;
      a|A) advanced_menu ;;
      0|q|Q|"")
        info "Bye. Bridge keeps running."
        info "Kill: $0 → option 4"
        exit 0 ;;
    esac
  done
}

init_files

if ! have_node; then
  banner
  err "Node.js required. Install: pkg install nodejs"
  exit 1
fi

if ! node -e "require('express')" 2>/dev/null; then
  banner
  warn "npm deps missing"
  read -r -p "Install now? [Y/n]: " c
  case "$c" in n|N) ;; *) cd "$TYN_DIR" && npm install express ws multer --save ;; esac
fi

main_menu