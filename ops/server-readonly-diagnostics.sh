#!/usr/bin/env bash
set -uo pipefail
export LC_ALL=C

: "${INCIDENT_START:?INCIDENT_START is required}"
: "${INCIDENT_END:?INCIDENT_END is required}"
: "${INCIDENT_RUN_ID:?INCIDENT_RUN_ID is required}"
: "${EXPECTED_PRODUCTION_SHA:?EXPECTED_PRODUCTION_SHA is required}"
: "${EXPECTED_STAGING_SHA:?EXPECTED_STAGING_SHA is required}"
: "${EXPECTED_PUBLIC_IP:?EXPECTED_PUBLIC_IP is required}"

verification_failures=0
health_checks=0
health_failures=0

section() {
  printf '\n===== %s =====\n' "$1"
}

sanitize() {
  sed -E \
    -e 's#https?://[^[:space:]"<>]+#<URL_REDACTED>#g' \
    -e 's#(authorization|apikey|api_key|token|secret|password)[=:][[:space:]]*(Bearer[[:space:]]+)?[^[:space:]]+#\1=<REDACTED>#Ig' \
    -e 's#([?&](token|apikey|api_key|key|secret|password)=)[^&[:space:]]+#\1<REDACTED>#Ig' \
    -e 's#eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}#<JWT_REDACTED>#g' \
    -e 's#\b([0-9]{1,3}\.){3}[0-9]{1,3}\b#<IP_REDACTED>#g' \
    -e 's#/home/[^/[:space:]]+#/home/<user>#g' \
    -e 's#/root([/[:space:]]|$)#/<root>\1#g'
}

record_failure() {
  verification_failures=$((verification_failures + 1))
  printf 'VERIFICATION_FAILURE\t%s\n' "$1" | sanitize
}

low_io_du() {
  if command -v ionice >/dev/null 2>&1; then
    ionice -c3 nice -n 19 du "$@"
  else
    nice -n 19 du "$@"
  fi
}

size_of() {
  local target="$1"
  low_io_du -x -B1 -s -- "$target" 2>/dev/null | awk '{print $1}'
}

inventory_root() {
  local root="$1"
  [[ -d "$root" ]] || return 0
  local total count
  total="$(size_of "$root")"
  count="$(find "$root" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
  printf 'ROOT\t%s\tcount=%s\tbytes=%s\n' "$root" "$count" "${total:-unavailable}" | sanitize
  find "$root" -mindepth 1 -maxdepth 1 -type d \
    -printf '%T@|%TY-%Tm-%TdT%TH:%TM:%TSZ|%p\n' 2>/dev/null \
    | sort -t'|' -k1,1nr \
    | while IFS='|' read -r _epoch modified path; do
        [[ -n "$path" ]] || continue
        printf 'ENTRY\t%s\tbytes=%s\tmodified=%s\n' "$path" "$(size_of "$path")" "$modified" | sanitize
      done
}

pm2_safe_inventory() {
  if ! command -v pm2 >/dev/null 2>&1; then
    printf 'PM2_UNAVAILABLE\n'
    return 0
  fi
  pm2 jlist 2>/dev/null | node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        const rows = JSON.parse(input);
        const safe = rows.map((row) => ({
          name: String(row.name ?? ""),
          pm_id: Number(row.pm_id ?? -1),
          pid: Number(row.pid ?? 0),
          status: String(row.pm2_env?.status ?? "missing"),
          restart_count: Number(row.pm2_env?.restart_time ?? -1),
          cwd: String(row.pm2_env?.pm_cwd ?? ""),
        }));
        process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
      } catch (error) {
        process.stdout.write(`PM2_PARSE_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    });
  ' | sanitize
}

pm2_required_checks() {
  if ! command -v pm2 >/dev/null 2>&1; then
    printf 'PM2_CHECK\tname=all\tstatus=unavailable\tmatch=0\n'
    return 0
  fi
  pm2 jlist 2>/dev/null | node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const expected = [
        ["kiwoom-proxy", "online", "/opt/kiwoom-proxy"],
        ["stock-app", "online", "/opt/stock-app"],
        ["stock-app-f6b2bea-canary", "online", "/opt/stock-app-releases/f6b2bea/api-server"],
        ["stock-signal-worker-f6b2bea-canary", "stopped", "/opt/stock-app-releases/f6b2bea/api-server"],
        ["stock-app-f6b2bea-production", "online", "/opt/stock-app-releases/f6b2bea-production/api-server"],
        ["seungjae-staging", "online", "/srv/seungjae-staging/api-server"],
      ];
      try {
        const rows = JSON.parse(input);
        for (const [name, status, cwd] of expected) {
          const row = rows.find((candidate) => String(candidate.name ?? "") === name);
          const actualStatus = String(row?.pm2_env?.status ?? "missing");
          const actualCwd = String(row?.pm2_env?.pm_cwd ?? "missing");
          const restartCount = Number(row?.pm2_env?.restart_time ?? -1);
          const match = actualStatus === status && actualCwd === cwd ? 1 : 0;
          process.stdout.write([
            "PM2_CHECK",
            `name=${name}`,
            `status=${actualStatus}`,
            `expected_status=${status}`,
            `restart_count=${restartCount}`,
            `cwd=${actualCwd}`,
            `expected_cwd=${cwd}`,
            `match=${match}`,
          ].join("\t") + "\n");
        }
      } catch {
        process.stdout.write("PM2_CHECK\tname=all\tstatus=parse_failed\tmatch=0\n");
      }
    });
  ' | sanitize
}

pm2_log_paths() {
  command -v pm2 >/dev/null 2>&1 || return 0
  pm2 jlist 2>/dev/null | node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        for (const row of JSON.parse(input)) {
          const name = String(row.name ?? "unknown").replace(/[\t\n\r]/g, "_");
          for (const kind of ["pm_out_log_path", "pm_err_log_path"]) {
            const value = String(row.pm2_env?.[kind] ?? "");
            if (value) process.stdout.write(`${name}\t${kind}\t${value}\n`);
          }
        }
      } catch {}
    });
  '
}

public_ipv4() {
  ip -4 -o addr show scope global 2>/dev/null \
    | awk '{split($4, address, "/"); print address[1]}' \
    | awk '
      function private(ip, octet) {
        split(ip, octet, ".");
        return octet[1] == 10 ||
          (octet[1] == 172 && octet[2] >= 16 && octet[2] <= 31) ||
          (octet[1] == 192 && octet[2] == 168) ||
          octet[1] == 127 ||
          (octet[1] == 169 && octet[2] == 254);
      }
      !private($0) { print; exit }
    '
}

caddy_route_map() {
  command -v caddy >/dev/null 2>&1 || return 0
  local adapted
  adapted="$(caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile 2>/dev/null)" || return 0
  printf '%s' "$adapted" | node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const targets = new Set([
        "lsj119.duckdns.org",
        "lsj119-staging.duckdns.org",
      ]);
      const rows = [];
      const seen = new Set();
      const safeDial = /^(127\.0\.0\.1|localhost):([0-9]{1,5})$/;
      const add = (hosts, dial) => {
        const match = safeDial.exec(String(dial ?? ""));
        if (!match) return;
        const port = Number(match[2]);
        if (!(port > 0 && port <= 65535)) return;
        for (const host of hosts) {
          if (!targets.has(host)) continue;
          const key = `${host}|${match[1]}:${port}`;
          if (!seen.has(key)) {
            seen.add(key);
            rows.push(key);
          }
        }
      };
      const matchHosts = (matches, inherited) => {
        const found = new Set();
        for (const match of Array.isArray(matches) ? matches : []) {
          for (const host of Array.isArray(match?.host) ? match.host : []) {
            if (targets.has(String(host))) found.add(String(host));
          }
        }
        return found.size ? found : inherited;
      };
      const walk = (value, inheritedHosts = new Set()) => {
        if (Array.isArray(value)) {
          for (const item of value) walk(item, inheritedHosts);
          return;
        }
        if (!value || typeof value !== "object") return;
        const hosts = matchHosts(value.match, inheritedHosts);
        if (value.handler === "reverse_proxy") {
          for (const upstream of Array.isArray(value.upstreams) ? value.upstreams : []) {
            add(hosts, upstream?.dial);
          }
        }
        for (const key of ["routes", "handle"]) {
          if (value[key]) walk(value[key], hosts);
        }
        if (value.apps?.http?.servers) walk(Object.values(value.apps.http.servers), hosts);
      };
      try {
        walk(JSON.parse(input));
        process.stdout.write(rows.sort().join("\n"));
        if (rows.length) process.stdout.write("\n");
      } catch {}
    });
  '
}

pm2_pid_for_name() {
  local expected_name="$1"
  command -v pm2 >/dev/null 2>&1 || return 0
  pm2 jlist 2>/dev/null | node -e '
    const expected = process.argv[1];
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        const row = JSON.parse(input).find((candidate) => String(candidate.name ?? "") === expected);
        const pid = Number(row?.pid ?? 0);
        if (Number.isInteger(pid) && pid > 0) process.stdout.write(String(pid));
      } catch {}
    });
  ' "$expected_name"
}

listening_dial_for_pid() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 0 ]] || return 0
  ss -H -ltnp 2>/dev/null \
    | awk -v expected="pid=${pid}," 'index($0, expected) { print $4; exit }' \
    | awk '
      {
        value=$0;
        sub(/^\[/, "", value);
        sub(/\]$/, "", value);
        port=value;
        sub(/^.*:/, "", port);
        if (port !~ /^[0-9]+$/) next;
        print "127.0.0.1:" port;
      }
    '
}

caddy_route_has_dial() {
  local routes="$1"
  local host="$2"
  local dial="$3"
  local expected_port="${dial##*:}"
  [[ "$expected_port" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$routes" \
    | awk -F'|' -v expected_host="$host" -v expected_port="$expected_port" '
        $1 == expected_host {
          port=$2;
          sub(/^.*:/, "", port);
          if (port == expected_port) found=1;
        }
        END { exit(found ? 0 : 1) }
      '
}

socket_port_is_listening() {
  local dial="$1"
  local port="${dial##*:}"
  [[ "$port" =~ ^[0-9]+$ ]] || return 1
  ss -H -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "(^|:)${port}$"
}

health_allowed_fields() {
  node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      if (input.length < 262144) input += chunk;
    });
    process.stdin.on("end", () => {
      const clean = (value) => String(value ?? "")
        .replace(/[\t\n\r]/g, " ")
        .slice(0, 200);
      try {
        const parsed = JSON.parse(input);
        const normalized = {
          status: parsed.status,
          ok: parsed.ok,
          sha: parsed.sha ?? parsed.deploySha,
          version: parsed.version,
          service: parsed.service,
          environment: parsed.environment,
          timestamp: parsed.timestamp ?? parsed.time,
        };
        const fields = [];
        for (const [key, value] of Object.entries(normalized)) {
          if (["string", "number", "boolean"].includes(typeof value)) {
            fields.push(`${key}=${clean(value)}`);
          }
        }
        process.stdout.write(fields.join("\t"));
      } catch {
        process.stdout.write("parse_error=1");
      }
    });
  '
}

health_probe() {
  local target="$1"
  local url="$2"
  local expected_sha="$3"
  local response curl_rc meta body status total content_type timeout_flag server_error fields actual_sha sha_match

  health_checks=$((health_checks + 1))
  response="$(curl --get --silent --show-error \
    --connect-timeout 5 --max-time 15 --max-filesize 262144 \
    --header 'Accept: application/json' \
    --write-out $'\n__DIAG_META__\t%{http_code}\t%{time_total}\t%{content_type}' \
    "$url" 2>/dev/null)"
  curl_rc=$?
  meta="$(printf '%s\n' "$response" | tail -n 1)"
  body="$(printf '%s\n' "$response" | sed '$d')"

  status=000
  total=0
  content_type=unavailable
  if [[ "$meta" == __DIAG_META__* ]]; then
    status="$(printf '%s\n' "$meta" | awk -F'\t' '{print $2}')"
    total="$(printf '%s\n' "$meta" | awk -F'\t' '{print $3}')"
    content_type="$(printf '%s\n' "$meta" | awk -F'\t' '{print $4}')"
  fi
  [[ -n "$content_type" ]] || content_type=unavailable
  content_type="$(printf '%s' "$content_type" | tr '\t\n\r ' '____' | cut -c1-120)"

  timeout_flag=0
  [[ "$curl_rc" -eq 28 ]] && timeout_flag=1
  server_error=0
  [[ "$status" =~ ^5[0-9][0-9]$ ]] && server_error=1

  fields="$(printf '%s' "$body" | health_allowed_fields)"
  actual_sha="$(printf '%s\n' "$fields" | tr '\t' '\n' | awk -F= '$1 == "sha" {print $2; exit}')"
  sha_match=0
  [[ -n "$actual_sha" && "$actual_sha" == "$expected_sha" ]] && sha_match=1

  printf 'HEALTH\ttarget=%s\tstatus=%s\ttotal_seconds=%s\ttimeout=%s\tserver_error=%s\tcontent_type=%s\texpected_sha=%s\tsha_match=%s' \
    "$target" "$status" "$total" "$timeout_flag" "$server_error" "$content_type" "$expected_sha" "$sha_match"
  [[ -n "$fields" ]] && printf '\t%s' "$fields"
  printf '\n'

  if [[ "$curl_rc" -ne 0 || "$status" != 200 || "$timeout_flag" -ne 0 || "$server_error" -ne 0 || "$sha_match" -ne 1 ]]; then
    health_failures=$((health_failures + 1))
    record_failure "health_${target}"
  fi
}

section 'diagnostic_identity'
printf 'mode=read_only\nincident_run_id=%s\nincident_start=%s\nincident_end=%s\ncollected_at=%s\n' \
  "$INCIDENT_RUN_ID" "$INCIDENT_START" "$INCIDENT_END" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'hostname='; hostname 2>/dev/null | sanitize || true
printf 'hostname_static='; hostnamectl --static 2>/dev/null | sanitize || true
printf 'kernel='; uname -srmo 2>/dev/null | sanitize || true
printf 'boot_time='; uptime -s 2>/dev/null | sanitize || true
printf 'uptime='; uptime 2>/dev/null | sanitize || true
printf 'cpu_count='; getconf _NPROCESSORS_ONLN 2>/dev/null || true
current_public_ip="$(public_ipv4)"
printf 'public_ip=%s\n' "${current_public_ip:-unavailable}"
printf 'expected_public_ip=%s\n' "$EXPECTED_PUBLIC_IP"
if [[ "$current_public_ip" != "$EXPECTED_PUBLIC_IP" ]]; then
  record_failure 'public_ip_mismatch'
fi

section 'block_devices'
if command -v lsblk >/dev/null 2>&1; then
  lsblk -o NAME,SIZE,FSTYPE,TYPE,MOUNTPOINTS 2>&1 | sanitize
else
  printf 'lsblk unavailable\n'
  record_failure 'lsblk_unavailable'
fi

section 'df_h'
df -hP 2>&1 | sanitize

section 'df_i'
df -iP 2>&1 | sanitize

section 'root_filesystem_bytes'
df -B1 -P / 2>&1 | sanitize

section 'root_mount'
if command -v findmnt >/dev/null 2>&1; then
  findmnt / -o TARGET,SOURCE,FSTYPE,OPTIONS 2>&1 | sanitize
else
  printf 'findmnt unavailable\n'
  record_failure 'findmnt_unavailable'
fi

section 'mounts'
if command -v findmnt >/dev/null 2>&1; then
  findmnt -rn -o TARGET,FSTYPE,OPTIONS 2>&1 | sanitize
else
  printf 'findmnt unavailable\n'
fi

section 'memory_and_swap'
free -b 2>&1 | sanitize
if command -v swapon >/dev/null 2>&1; then
  swapon --show --bytes --noheadings --output TYPE,SIZE,USED,PRIO 2>&1 | sanitize
else
  printf 'swapon unavailable\n'
fi
grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree|Dirty|Writeback):' /proc/meminfo 2>/dev/null | sanitize || true

section 'current_load_and_processes'
if command -v vmstat >/dev/null 2>&1; then vmstat 1 10 2>&1 | sanitize; fi
if command -v mpstat >/dev/null 2>&1; then mpstat 1 10 2>&1 | sanitize; fi
if command -v iostat >/dev/null 2>&1; then iostat -xz 1 3 2>&1 | sanitize; fi
ps -eo pid,comm,%cpu,%mem,rss,vsz,etimes --sort=-%cpu 2>/dev/null | head -n 31 | sanitize

section 'active_build_and_browser_processes'
ps -eo pid,comm,etimes 2>/dev/null \
  | grep -Ei '[p]laywright|[c]hromium|[c]hrome|[v]ite|[p]npm|[n]pm' \
  | head -n 100 | sanitize || true

section 'srv_top_directories_bytes'
low_io_du -x -B1 -d 2 /srv 2>/dev/null | sort -nr | head -n 100 | sanitize

section 'opt_top_directories_bytes'
low_io_du -x -B1 -d 2 /opt 2>/dev/null | sort -nr | head -n 80 | sanitize

section 'release_and_backup_inventory'
{
  printf '%s\n' \
    /srv/seungjae-staging-releases \
    /srv/seungjae-staging-backups \
    /srv/stock-app-releases \
    /srv/stock-app-backups \
    /srv/seungjae-production-releases \
    /srv/seungjae-production-backups \
    /opt/stock-app-releases \
    /opt/stock-app-backups
  find /srv /opt -maxdepth 2 -type d \( -iname '*releases*' -o -iname '*backups*' \) -print 2>/dev/null
} | awk 'NF && !seen[$0]++' | while IFS= read -r root; do inventory_root "$root"; done

section 'deployment_state_files'
find /srv /opt -maxdepth 5 -type f \
  \( -path '*/.deploy/current-sha' -o -path '*/.deploy/last-backup' -o -name 'previous-sha.txt' \) \
  -print 2>/dev/null | sort | while IFS= read -r file; do
    printf 'STATE\t%s\tvalue=' "$file" | sanitize
    sed -n '1p' "$file" 2>/dev/null | sanitize
  done

production_sha="$(sed -n '1p' /opt/stock-app/.deploy/current-sha 2>/dev/null | tr -d '\r\n')"
staging_sha="$(sed -n '1p' /srv/seungjae-staging/.deploy/current-sha 2>/dev/null | tr -d '\r\n')"
printf 'SHA_CHECK\ttarget=production\tactual=%s\texpected=%s\tmatch=%s\n' \
  "${production_sha:-unavailable}" "$EXPECTED_PRODUCTION_SHA" "$([[ "$production_sha" == "$EXPECTED_PRODUCTION_SHA" ]] && printf 1 || printf 0)"
printf 'SHA_CHECK\ttarget=staging\tactual=%s\texpected=%s\tmatch=%s\n' \
  "${staging_sha:-unavailable}" "$EXPECTED_STAGING_SHA" "$([[ "$staging_sha" == "$EXPECTED_STAGING_SHA" ]] && printf 1 || printf 0)"
[[ "$production_sha" == "$EXPECTED_PRODUCTION_SHA" ]] || record_failure 'production_state_sha_mismatch'
[[ "$staging_sha" == "$EXPECTED_STAGING_SHA" ]] || record_failure 'staging_state_sha_mismatch'

section 'current_release_links'
find /srv /opt -maxdepth 4 -type l \
  \( -name current -o -name current-release -o -name production -o -name staging \) \
  -print 2>/dev/null | sort | while IFS= read -r link; do
    printf 'LINK\t%s\ttarget=%s\n' "$link" "$(readlink -f "$link" 2>/dev/null || true)" | sanitize
  done
printf 'PATH_CHECK\ttarget=production\tresolved=%s\n' "$(readlink -f /opt/stock-app 2>/dev/null || true)" | sanitize
printf 'PATH_CHECK\ttarget=staging\tresolved=%s\n' "$(readlink -f /srv/seungjae-staging 2>/dev/null || true)" | sanitize

section 'pm2_safe_inventory'
pm2_safe_inventory
pm2_checks="$(pm2_required_checks)"
printf '%s\n' "$pm2_checks"
while IFS= read -r pm2_check; do
  [[ -n "$pm2_check" ]] || continue
  [[ "$pm2_check" == *$'\tmatch=1' ]] || record_failure 'pm2_required_process_mismatch'
done <<< "$pm2_checks"

section 'pm2_log_sizes'
pm2_log_paths | while IFS=$'\t' read -r name kind path; do
  [[ -n "$path" ]] || continue
  if [[ -e "$path" ]]; then
    printf 'PM2_LOG\tname=%s\tkind=%s\tbytes=%s\tmodified=%s\tpath=%s\n' \
      "$name" "$kind" "$(stat -c %s "$path" 2>/dev/null || printf unavailable)" \
      "$(stat -c %y "$path" 2>/dev/null || printf unavailable)" "$path" | sanitize
  fi
done
if [[ -d "$HOME/.pm2/logs" ]]; then low_io_du -x -B1 -d 1 "$HOME/.pm2/logs" 2>/dev/null | sort -nr | sanitize; fi

section 'caddy_service_and_config'
caddy_active="$(systemctl is-active caddy 2>/dev/null || true)"
printf 'CADDY_SERVICE\tactive_state=%s\n' "${caddy_active:-unavailable}"
[[ "$caddy_active" == active ]] || record_failure 'caddy_not_active'
if command -v caddy >/dev/null 2>&1; then
  caddy_validation="$(caddy validate --config /etc/caddy/Caddyfile 2>&1)"
  caddy_validation_rc=$?
  printf 'CADDY_VALIDATE\tvalid=%s\texit_code=%s\n' \
    "$([[ "$caddy_validation_rc" -eq 0 ]] && printf 1 || printf 0)" "$caddy_validation_rc"
  if [[ "$caddy_validation_rc" -ne 0 ]]; then
    printf '%s\n' "$caddy_validation" | tail -n 30 | sanitize
    record_failure 'caddy_config_invalid'
  fi
else
  printf 'CADDY_VALIDATE\tvalid=0\texit_code=127\n'
  record_failure 'caddy_unavailable'
fi

section 'listening_sockets'
if command -v ss >/dev/null 2>&1; then
  ss -H -ltnp 2>/dev/null \
    | grep -E 'caddy|node|bash|:80[[:space:]]|:443[[:space:]]' \
    | head -n 100 | sanitize || true
else
  printf 'ss unavailable\n'
  record_failure 'ss_unavailable'
fi

section 'caddy_route_mapping'
caddy_routes="$(caddy_route_map)"
production_pid="$(pm2_pid_for_name 'stock-app')"
staging_pid="$(pm2_pid_for_name 'seungjae-staging')"
production_dial="$(listening_dial_for_pid "$production_pid")"
staging_dial="$(listening_dial_for_pid "$staging_pid")"
printf '%s\n' "$caddy_routes" | while IFS='|' read -r host dial; do
  [[ -n "$host" && -n "$dial" ]] || continue
  printf 'CADDY_ROUTE\thost=%s\tport=%s\n' "$host" "${dial##*:}"
done
printf 'INTERNAL_ROUTE\ttarget=production\tpm2_name=stock-app\tpid=%s\tdial=%s\n' \
  "${production_pid:-unavailable}" "${production_dial:-unavailable}"
printf 'INTERNAL_ROUTE\ttarget=staging\tpm2_name=seungjae-staging\tpid=%s\tdial=%s\n' \
  "${staging_pid:-unavailable}" "${staging_dial:-unavailable}"
if [[ -z "$production_dial" ]]; then record_failure 'production_internal_socket_unresolved'; fi
if [[ -z "$staging_dial" ]]; then record_failure 'staging_internal_socket_unresolved'; fi
if [[ -n "$production_dial" ]] && ! socket_port_is_listening "$production_dial"; then
  record_failure 'production_internal_socket_not_listening'
fi
if [[ -n "$staging_dial" ]] && ! socket_port_is_listening "$staging_dial"; then
  record_failure 'staging_internal_socket_not_listening'
fi
if [[ -n "$production_dial" ]] && ! caddy_route_has_dial "$caddy_routes" 'lsj119.duckdns.org' "$production_dial"; then
  record_failure 'production_caddy_route_mismatch'
fi
if [[ -n "$staging_dial" ]] && ! caddy_route_has_dial "$caddy_routes" 'lsj119-staging.duckdns.org' "$staging_dial"; then
  record_failure 'staging_caddy_route_mismatch'
fi

section 'health_verification'
if [[ -n "$production_dial" ]]; then
  health_probe 'production-internal' "http://${production_dial}/api/health" "$EXPECTED_PRODUCTION_SHA"
fi
health_probe 'production-external' 'https://lsj119.duckdns.org/api/health' "$EXPECTED_PRODUCTION_SHA"
if [[ -n "$staging_dial" ]]; then
  health_probe 'staging-internal' "http://${staging_dial}/api/health" "$EXPECTED_STAGING_SHA"
fi
health_probe 'staging-external' 'https://lsj119-staging.duckdns.org/api/health' "$EXPECTED_STAGING_SHA"

section 'caddy_boot_logs'
if command -v journalctl >/dev/null 2>&1; then
  journalctl -u caddy -b --no-pager -n 200 2>&1 \
    | grep -Ei 'started|stopped|failed|error|502|upstream|timeout|connection refused|connection reset|ENOSPC|No space left|ENOMEM|out of memory|oom' \
    | tail -n 200 | sanitize || true
else
  printf 'journalctl unavailable\n'
fi

section 'system_log_sizes'
if [[ -d /var/log ]]; then low_io_du -x -B1 -d 2 /var/log 2>/dev/null | sort -nr | head -n 100 | sanitize; fi
if command -v journalctl >/dev/null 2>&1; then journalctl --disk-usage 2>&1 | sanitize; fi

section 'package_and_browser_cache_sizes'
for cache in \
  "$HOME/.pnpm-store" \
  "$HOME/.local/share/pnpm/store" \
  "$HOME/.cache/pnpm" \
  "$HOME/.npm" \
  "$HOME/.cache/ms-playwright" \
  /root/.pnpm-store \
  /root/.local/share/pnpm/store \
  /root/.cache/pnpm \
  /root/.npm \
  /root/.cache/ms-playwright; do
  [[ -d "$cache" ]] || continue
  printf 'CACHE\t%s\tbytes=%s\n' "$cache" "$(size_of "$cache")" | sanitize
done
find /home -maxdepth 4 -type d \( -name ms-playwright -o -name '.pnpm-store' -o -name '.npm' \) -print 2>/dev/null \
  | while IFS= read -r cache; do printf 'CACHE\t%s\tbytes=%s\n' "$cache" "$(size_of "$cache")" | sanitize; done

section 'tmp_and_temporary_build_directories'
low_io_du -x -B1 -d 1 /tmp 2>/dev/null | sort -nr | head -n 100 | sanitize
find /tmp -mindepth 1 -maxdepth 2 -type d \
  \( -name 'seungjae-staging-source.*' -o -name '*build*' -o -name '*release*' -o -name 'pnpm-*' \) \
  -printf '%T@|%TY-%Tm-%TdT%TH:%TM:%TSZ|%p\n' 2>/dev/null \
  | sort -t'|' -k1,1nr \
  | head -n 100 \
  | while IFS='|' read -r _epoch modified path; do
      printf 'TEMP_DIR\t%s\tbytes=%s\tmodified=%s\n' "$path" "$(size_of "$path")" "$modified" | sanitize
    done

section 'open_deleted_files'
if command -v lsof >/dev/null 2>&1; then
  lsof -nP +L1 2>/dev/null \
    | awk 'NR==1 {print; next} {size=$7; if (size ~ /^[0-9]+$/) total+=size; print} END {print "OPEN_DELETED_TOTAL_BYTES", total+0}' \
    | head -n 100 | sanitize
else
  printf 'lsof unavailable\n'
fi

section 'incident_system_and_proxy_logs'
if command -v journalctl >/dev/null 2>&1; then
  journalctl --since "$INCIDENT_START" --until "$INCIDENT_END" --no-pager -o short-iso 2>&1 \
    | grep -Ei '502|watchlist|scanner|seungjae-staging|ENOSPC|No space left|ENOMEM|out of memory|oom|timeout|ECONN|EAI_AGAIN|upstream|SIG' \
    | tail -n 600 | sanitize || true
else
  printf 'journalctl unavailable\n'
fi

section 'incident_pm2_application_logs'
pm2_log_paths | while IFS=$'\t' read -r name kind path; do
  [[ -r "$path" ]] || continue
  matches="$(tail -n 20000 "$path" 2>/dev/null \
    | grep -Ei '\[watchlist\]|WATCHLIST_STORE_ERROR|/api/watchlist/sync|scanner|502|ENOSPC|No space left|ENOMEM|out of memory|oom|timeout|ECONN|EAI_AGAIN|SIG' \
    | tail -n 300 || true)"
  [[ -n "$matches" ]] || continue
  printf -- '--- PM2_LOG_MATCH name=%s kind=%s path=%s ---\n' "$name" "$kind" "$path" | sanitize
  printf '%s\n' "$matches" | sanitize
done

section 'incident_proxy_log_files'
find /var/log -maxdepth 3 -type f \( -iname '*caddy*' -o -path '*/nginx/*' \) -print 2>/dev/null \
  | head -n 50 \
  | while IFS= read -r path; do
      [[ -r "$path" ]] || continue
      matches="$(tail -n 20000 "$path" 2>/dev/null \
        | grep -Ei '502|/api/watchlist/sync|/scanner|upstream|timeout|connect' \
        | tail -n 300 || true)"
      [[ -n "$matches" ]] || continue
      printf -- '--- PROXY_LOG_MATCH path=%s ---\n' "$path" | sanitize
      printf '%s\n' "$matches" | sanitize
    done

section 'kernel_resource_pressure_signals'
if command -v journalctl >/dev/null 2>&1; then
  journalctl -k --since "$INCIDENT_START" --until "$INCIDENT_END" --no-pager -o short-iso 2>&1 \
    | grep -Ei 'oom|out of memory|killed process|ENOSPC|No space left|I/O error|blocked for more than|ext4|xfs' \
    | tail -n 300 | sanitize || true
fi

section 'service_verification_verdict'
printf 'health_checks=%s\nhealth_failures=%s\nverification_failures=%s\n' \
  "$health_checks" "$health_failures" "$verification_failures"
if [[ "$verification_failures" -eq 0 && "$health_checks" -eq 4 && "$health_failures" -eq 0 ]]; then
  printf 'service_verification_status=passed\n'
else
  printf 'service_verification_status=failed\n'
fi

section 'read_only_contract'
printf 'server_files_written=0\nserver_files_deleted=0\nserver_processes_restarted=0\nserver_processes_stopped=0\ndeployment_executed=0\ndatabase_changes=0\nsecret_values_collected=0\nREAD_ONLY_DIAGNOSTICS_COMPLETE\n'
