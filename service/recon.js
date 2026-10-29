/* TV Recon — TizenBrew service module
 * Runs inside the TizenBrew service sandbox (Node.js v4.4.3-era, ES5 only!)
 * Reports findings to the analyst workstation over HTTP.
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
        req.on('error', function () { /* silent */ });
        req.end(body);
    } catch (e) {
        try { console.log('post fail: ' + e); } catch (e2) {}
    }
}

function T(fn) { try { return fn(); } catch (e) { return 'ERR: ' + (e && e.message ? e.message : String(e)); } }

console.log('TV Recon service starting...');
post('hello', { time: new Date().toISOString(), msg: 'TV Recon online' });

/* 1. Runtime environment */
post('env', {
    versions: T(function () { return process.versions; }),
    arch: T(function () { return process.arch; }),
    platform: T(function () { return process.platform; }),
    pid: process.pid,
    cwd: T(function () { return process.cwd(); }),
    env: T(function () { return process.env; }),
    uid: T(function () { return process.getuid ? process.getuid() : 'no getuid'; }),
    gid: T(function () { return process.getgid ? process.getgid() : 'no getgid'; }),
    execPath: T(function () { return process.execPath; }),
    argv: T(function () { return process.argv; })
});

/* 2. Which Node modules can we require? */
['fs', 'path', 'http', 'https', 'net', 'os', 'crypto', 'vm', 'dns', 'dgram',
 'child_process', 'tls', 'zlib', 'events', 'stream', 'util', 'assert',
 'adbhost', 'express', 'ws', 'node-fetch'].forEach(function (m) {
    post('module', { name: m, available: T(function () { require(m); return 'YES'; }) });
});

/* 3. THE BIG TEST: can we spawn OS processes? */
try {
    var cp = require('child_process');
    post('child_process', { available: 'YES, testing exec' });
    cp.exec('id; echo ---; uname -a; echo ---; cat /proc/self/status | head -5', function (err, stdout, stderr) {
        post('exec-id', { err: err ? String(err) : null, stdout: String(stdout), stderr: String(stderr) });
    });
    cp.exec('ps aux 2>/dev/null | head -60 || ps -ef | head -60', function (err, stdout) {
        post('exec-ps', { err: err ? String(err) : null, stdout: String(stdout).slice(0, 8000) });
    });
    cp.exec('netstat -tlnp 2>/dev/null || cat /proc/net/tcp', function (err, stdout) {
        post('exec-netstat', { err: err ? String(err) : null, stdout: String(stdout).slice(0, 8000) });
    });
} catch (e) {
    post('child_process', { available: 'NO', error: String(e) });
}

/* 4. Filesystem enumeration */
var fs = T(function () { return require('fs'); });
if (typeof fs === 'object' && fs && fs.readdirSync) {
    ['/', '/bin', '/sbin', '/usr/bin', '/etc', '/opt', '/opt/etc', '/opt/usr',
     '/home', '/home/owner', '/home/owner/share', '/tmp', '/dev', '/proc',
     '/opt/usr/apps', '/opt/usr/home', '/etc/sysmgr', '/rom', '/mnt'].forEach(function (d) {
        post('fs', { dir: d, listing: T(function () { return fs.readdirSync(d).slice(0, 100); }) });
    });
    /* Files of interest */
    ['/etc/passwd', '/etc/group', '/etc/hostname', '/etc/fstab', '/etc/hosts',
     '/etc/sdbd.conf', '/opt/etc/sdbd.conf', '/etc/sysmgr/smack/load2', '/etc/smack/accesses',
     '/proc/mounts', '/proc/cpuinfo', '/proc/meminfo', '/proc/self/status',
     '/proc/self/cmdline', '/proc/version', '/etc/version', '/etc/tizen-build-info',
     '/opt/etc/ceilometer.cfg', '/etc/systemd/system.conf'].forEach(function (f) {
        post('file', { path: f, content: T(function () { return fs.readFileSync(f, 'utf8').slice(0, 6000); }) });
    });
}

/* 5. Tizen API surface in the service context */
post('tizen', {
    hasTizen: typeof tizen !== 'undefined',
    keys: T(function () { return Object.keys(tizen); }),
    application: T(function () { return Object.keys(tizen.application || {}); }),
    systeminfo: T(function () { return Object.keys(tizen.systeminfo || {}); }),
    package: T(function () { return Object.keys(tizen.package || {}); }),
    filesystem: T(function () { return Object.keys(tizen.filesystem || {}); })
});

/* 6. Speak to our own sdbd from TV localhost (bundled adbhost) */
try {
    var adbhost = require('adbhost');
    var client = adbhost.createConnection({ host: '127.0.0.1', port: 26101 });
    var s1 = client.createStream('shell:0 vd_applist');
    var out1 = '';
    s1.on('data', function (d) { out1 += d.toString(); });
    s1.on('end', function () { post('sdbd-applist', { ok: true, output: out1.slice(0, 2000) }); });
    s1.on('error', function (e) { post('sdbd-applist', { ok: false, error: String(e) }); });

    var s2 = client.createStream('shell:id');
    var out2 = '';
    s2.on('data', function (d) { out2 += d.toString(); });
    s2.on('end', function () { post('sdbd-raw-shell', { ok: out2.length > 0, output: out2.slice(0, 1000) }); });
    s2.on('error', function (e) { post('sdbd-raw-shell', { ok: false, error: String(e) }); });
} catch (e) {
    post('sdbd', { error: String(e) });
}

console.log('TV Recon: all probes dispatched');

/* Mark this module 'crashed' so the page's StartService timer
 * re-fetches the latest version from the CDN on the next cycle. */
throw new Error('RECON_CYCLE_COMPLETE');
